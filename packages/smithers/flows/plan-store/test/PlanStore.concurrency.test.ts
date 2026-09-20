/**
 * The plan store against a real file-backed SQLite database, with two real
 * connections.
 *
 * `PlanStore.test.ts` drives first-writer-wins, the compare-and-swap append and
 * the one-statement read through a single in-memory connection, in sequence.
 * That cannot show what any of them is for: the window each closes is a
 * *second connection* recording, appending, or reading at the same time. These
 * cases open two connections on one tmpdir file, align them on a latch, and
 * assert the durable outcome — the same shape `CacheStoreDurable.test.ts` uses
 * for the step cache and `JournalDurable.test.ts` for the journal's allocation
 * contract.
 *
 * Child processes are not available to this package's tooling, so "two writers"
 * is two independent `NodeDatabase` connections in one process. That is the
 * boundary the SQLite locking protocol actually arbitrates; the process
 * boundary above it adds no further serialization.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-plan-durable-"))),
    (directory) => body(join(directory, "plan.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

/**
 * One migrated connection's client and writer. The busy timeout is short and
 * nonzero: the loser of a lock race must wait for the winner rather than be
 * handed the file, and it must not wait so long that a wedge looks like work.
 */
const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.merge(
      Layer.provideMerge(
        DurableWriter.layer(),
        NodeDatabase.layer({ filename, busyTimeout: Duration.millis(250) })
      ),
      NodeCrypto.layer
    )
  )

/** One independent connection to the file, as its own plan store instance. */
const connection = (filename: string) =>
  Effect.map(
    Layer.build(PlanStore.layer.pipe(Layer.provide(migrated(filename)))),
    (context) => Context.get(context, PlanStore.PlanStore)
  )

/** Runs raw SQL through a throwaway connection, as a cold reopen would. */
const onReopen = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, SqlClient.SqlClient | PlanStore.PlanStore>
): Effect.Effect<A, E> =>
  // A reopen that cannot migrate is a broken fixture, not an outcome under
  // test, so its failure is a defect rather than part of `body`'s errors.
  Effect.scoped(Effect.provide(body, Layer.orDie(PlanStore.layer.pipe(Layer.provideMerge(migrated(filename))))))

/** The node ids the file holds, in recorded order. */
const nodeIds = (filename: string): Effect.Effect<ReadonlyArray<string>> =>
  onReopen(
    filename,
    Effect.flatMap(
      Effect.service(SqlClient.SqlClient),
      (sql) =>
        sql<{ readonly node_id: string }>`
          SELECT node_id FROM flows_plan_nodes ORDER BY ordinal
        `.pipe(Effect.map((rows) => rows.map((row) => row.node_id)), Effect.orDie)
    )
  )

/** Every edge the file holds, as `from->to`, in a stable order. */
const edges = (filename: string): Effect.Effect<ReadonlyArray<string>> =>
  onReopen(
    filename,
    Effect.flatMap(
      Effect.service(SqlClient.SqlClient),
      (sql) =>
        sql<{ readonly from_node: string; readonly to_node: string }>`
          SELECT from_node, to_node FROM flows_plan_edges ORDER BY from_node, to_node
        `.pipe(Effect.map((rows) => rows.map((row) => `${row.from_node}->${row.to_node}`)), Effect.orDie)
    )
  )

const basePlan = () =>
  compile([
    draft("root", { writes: ["out"] }),
    draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })
  ])

/** An append's outcome as a value, so both racers have one result type. */
type Attempt =
  | { readonly _tag: "Landed" }
  | { readonly _tag: "Refused"; readonly failure: PlanStore.PlanStoreError }

const attempt = (effect: Effect.Effect<void, PlanStore.PlanStoreError>): Effect.Effect<Attempt> =>
  Effect.match(effect, {
    onSuccess: (): Attempt => ({ _tag: "Landed" }),
    onFailure: (failure): Attempt => ({ _tag: "Refused", failure })
  })

/** Releases both fibers from one latch, then joins them in fork order. */
const raced = <A, E>(
  left: Effect.Effect<A, E>,
  right: Effect.Effect<A, E>
): Effect.Effect<readonly [A, A], E> =>
  Effect.gen(function*() {
    const start = yield* Deferred.make<void>()
    const gated = (effect: Effect.Effect<A, E>) => Deferred.await(start).pipe(Effect.andThen(effect))
    const leftFiber = yield* Effect.forkChild(gated(left), { startImmediately: true })
    const rightFiber = yield* Effect.forkChild(gated(right), { startImmediately: true })
    // Both writers are parked on the latch; releasing it is the only ordering
    // this test imposes.
    yield* Deferred.succeed(start, undefined)
    return [yield* Fiber.join(leftFiber), yield* Fiber.join(rightFiber)] as const
  })

describe("PlanStore across real connections", () => {
  it.effect(
    "admits one durable copy when two connections record the same plan at once",
    () =>
      Effect.gen(function*() {
        const plan = yield* withCrypto(basePlan())
        const { outcomes, read, rows } = yield* withTempFile((filename) =>
          Effect.scoped(
            Effect.gen(function*() {
              // Migrate once so both writers open an already-provisioned file.
              yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
              const left = yield* connection(filename)
              const right = yield* connection(filename)
              const outcomes = yield* raced(left.record(plan, 1), right.record(plan, 2))
              const rows = yield* nodeIds(filename)
              // A cold reopen, so the assertion is about the file rather than
              // about either writer's session.
              const read = yield* onReopen(
                filename,
                Effect.flatMap(PlanStore.PlanStore, (store) => Effect.orDie(store.get(plan.planId)))
              )
              return { outcomes, read, rows }
            })
          )
        )

        // One writer inserted; the other found its own plan already there and
        // was told so, rather than being handed a conflict or a second copy.
        expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["ExistingSame", "Recorded"])
        expect(rows).toEqual(plan.nodes.map((node) => node.id))
        expect(Option.getOrThrow(read)).toEqual(plan)
      }),
    30_000
  )

  it.effect(
    "admits exactly one durable winner when two connections record different plans under one id",
    () =>
      Effect.gen(function*() {
        const mine = yield* withCrypto(basePlan())
        const theirs = yield* withCrypto(compile([draft("usurper", { body: { seed: 9 } })]))
        const contender: Plan.Plan = { ...theirs, planId: mine.planId }
        const { edgeRows, outcomes, read, rows } = yield* withTempFile((filename) =>
          Effect.scoped(
            Effect.gen(function*() {
              yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
              const left = yield* connection(filename)
              const right = yield* connection(filename)
              const outcomes = yield* raced(left.record(mine, 1), right.record(contender, 2))
              const rows = yield* nodeIds(filename)
              const edgeRows = yield* edges(filename)
              const read = yield* onReopen(
                filename,
                Effect.flatMap(PlanStore.PlanStore, (store) => Effect.orDie(store.get(mine.planId)))
              )
              return { edgeRows, outcomes, read, rows }
            })
          )
        )

        const recorded = outcomes.filter((outcome) => outcome._tag === "Recorded")
        const conflicts = outcomes.filter((outcome) => outcome._tag === "Conflict")
        expect(recorded).toHaveLength(1)
        expect(conflicts).toHaveLength(1)

        // The file holds one writer's graph end to end: the loser contributed
        // no node row, no edge row, and no digest.
        const winner = Option.getOrThrow(read)
        const expected = winner.digest === mine.digest ? mine : contender
        expect(winner).toEqual(expected)
        expect(rows).toEqual(expected.nodes.map((node) => node.id))
        expect(edgeRows).toEqual(expected === mine ? ["root->child"] : [])
        expect(conflicts[0]).toEqual({ _tag: "Conflict", digest: winner.digest })
      }),
    30_000
  )

  it.effect(
    "lets one of two divergent same-generation appends land and takes the loser's rows back with it",
    () =>
      Effect.gen(function*() {
        const base = yield* withCrypto(basePlan())
        const left = yield* withCrypto(
          Plan.append(base, [draft("left", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })])
        )
        const right = yield* withCrypto(
          Plan.append(base, [draft("right", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })])
        )
        const { edgeRows, outcomes, read, rows } = yield* withTempFile((filename) =>
          Effect.scoped(
            Effect.gen(function*() {
              yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
              const one = yield* connection(filename)
              const two = yield* connection(filename)
              yield* one.record(base, 1)
              const outcomes = yield* raced(attempt(one.append(left)), attempt(two.append(right)))
              const rows = yield* nodeIds(filename)
              const edgeRows = yield* edges(filename)
              const read = yield* onReopen(
                filename,
                Effect.flatMap(PlanStore.PlanStore, (store) => Effect.orDie(store.get(base.planId)))
              )
              return { edgeRows, outcomes, read, rows }
            })
          )
        )

        // Both grew generation 1 from the same generation 0. The compare-and-
        // swap on `generation = 0` admits the first to commit and leaves the
        // second describing a plan that has already moved.
        const refused = outcomes.filter((outcome) => outcome._tag === "Refused")
        expect(outcomes.filter((outcome) => outcome._tag === "Landed")).toHaveLength(1)
        expect(refused).toHaveLength(1)
        expect(refused[0]!._tag === "Refused" && refused[0]!.failure).toMatchObject({
          code: "constraint",
          message: `plan ${base.planId} was never recorded, or generation 1 was skipped or moved under the append`
        })

        // The loser's node and edge rows never survived its own transaction —
        // and the append-only triggers mean a surviving one could never be
        // removed.
        const winner = Option.getOrThrow(read)
        const expected = winner.digest === left.digest ? left : right
        const loser = expected === left ? "right" : "left"
        expect(winner).toEqual(expected)
        expect(rows).toEqual(expected.nodes.map((node) => node.id))
        expect(rows).not.toContain(loser)
        expect(edgeRows).toEqual([`root->${expected === left ? "left" : "right"}`, "root->child"].sort())
      }),
    30_000
  )

  it.effect(
    "serves whole plans to a reader racing an append on another connection",
    () =>
      Effect.gen(function*() {
        const base = yield* withCrypto(basePlan())
        const grown = yield* withCrypto(
          Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
        )
        const { observed, read } = yield* withTempFile((filename) =>
          Effect.scoped(
            Effect.gen(function*() {
              yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
              const writer = yield* connection(filename)
              const reader = yield* connection(filename)
              yield* writer.record(base, 1)
              const [observed] = yield* raced(
                Effect.forEach(
                  Array.from({ length: 20 }, (_, index) => index),
                  () => Effect.orDie(reader.get(base.planId))
                ),
                Effect.as(Effect.orDie(writer.append(grown)), [])
              )
              const read = yield* onReopen(
                filename,
                Effect.flatMap(PlanStore.PlanStore, (store) => Effect.orDie(store.get(base.planId)))
              )
              return { observed, read }
            })
          )
        )

        // Every read decoded, and every read that saw the plan saw one whole
        // generation of it: the envelope's digest never described nodes the
        // same statement did not return.
        expect(observed).toHaveLength(20)
        for (const found of observed) {
          const plan = Option.getOrThrow(found)
          expect([base.digest, grown.digest]).toContain(plan.digest)
          expect(plan).toEqual(plan.digest === base.digest ? base : grown)
        }
        expect(Option.getOrThrow(read)).toEqual(grown)
      }),
    30_000
  )
})
