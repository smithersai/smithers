import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * What a resumed run's replay costs. A run parked after its steps and woken
 * by a new incarnation, as a Cloudflare Durable Object's next alarm wakes it,
 * drives its body from the top: every step it ran is dispatched again and
 * answered from its attempt row. That used to cost each replayed step a
 * survivor probe, a row read, a fence heartbeat and a write transaction that
 * re-recorded its node and attempt records, about 31 statements a step on
 * PostgreSQL. A round now reads the run's attempts and journal once, and a
 * replayed step reads and writes nothing, so a resume costs the same however
 * long the run's history is. Runs on the test database the matrix selects:
 * SQLite, or PostgreSQL under `SMITHERS_TEST_PG_URL`.
 */
import { Action, Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Context from "effect/Context"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Statement from "effect/sql/Statement"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.vibe"
import * as PlanInputStore from "../src/PlanInputStore.vibe"
import * as PlanMergeStore from "../src/PlanMergeStore.vibe"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "replay-cost" as never, changeId: "replay-cost" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const Step = Action.make("ReplayCost/Step", { payload: { index: Schema.Number }, success: Schema.Number })

type StepsFlow = Flow.Flow<
  "ReplayCost/Steps",
  Schema.Struct<{ steps: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Sleep.SleepRequestInvalid,
  Action.Requirement<"ReplayCost/Step">
>

/** `steps` steps, a ten-minute durable sleep the run parks on, and one step after it. */
const Steps: StepsFlow = Flow.make("ReplayCost/Steps", {
  payload: { steps: Schema.Number },
  success: Schema.Number,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, ({ steps }: { steps: number }) => {
    let chain = Node.succeed(0) as never as Node.Node<number>
    for (let index = 0; index < steps; index++) {
      chain = chain.pipe(Node.andThen(Step.call({ index }))) as never as Node.Node<number>
    }
    return chain.pipe(
      Node.andThen(Sleep.action.call({ millis: 600_000 })),
      Node.andThen(Step.call({ index: steps }))
    )
  })
})

/** The two incarnations of one Durable Object: the same host, a new pid and nonce each. */
const first: Ownership.OwnerId = { hostId: "replay-cost-object", pid: 1, nonce: "first" }
const second: Ownership.OwnerId = { hostId: "replay-cost-object", pid: 2, nonce: "second" }

/** What one round sent: its SQL statements, and the store calls a replayed step would make. */
interface Tally {
  on: boolean
  statements: number
  gets: number
  lists: number
  heartbeats: number
}

/**
 * What the stores offer a round's replay: the attempt store's `listRun` and the
 * journal's `recall` and `recorded`, absent from stores that offer none, or an
 * attempt store whose `listRun` fails.
 */
type Seeding = "whole" | "absent" | "failing"

/** The attempt and run stores, counting the reads and heartbeats a dispatch makes while `tally.on`. */
const countingStores = (tally: Tally, seeding: Seeding) =>
  Layer.effectContext(Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const runs = yield* RunStore.RunStore
    const journal = yield* Journal.Journal
    const listRun: AttemptStore.Service["listRun"] = seeding === "absent" ? undefined : (runId) =>
      Effect.suspend(() => {
        if (tally.on) tally.lists++
        return seeding === "failing"
          ? Effect.fail(new AttemptStore.AttemptStoreError({ code: "unknown", method: "listRun", message: "down" }))
          : attempts.listRun!(runId)
      })
    return Context.make(AttemptStore.AttemptStore, {
      ...attempts,
      get: (id) => Effect.suspend(() => (tally.on && tally.gets++, attempts.get(id))),
      listRun
    }).pipe(
      Context.add(RunStore.RunStore, {
        ...runs,
        heartbeat: (...args) => Effect.suspend(() => (tally.on && tally.heartbeats++, runs.heartbeat(...args)))
      }),
      Context.add(
        Journal.Journal,
        seeding === "absent" ? { ...journal, recall: undefined, recorded: undefined } : journal
      )
    )
  }))

/** An incarnation's runtime: a hosted engine over the shared database, with `Steps` registered. */
const incarnation = (
  database: Context.Context<Layer.Success<typeof TestStores.database>>,
  owner: Ownership.OwnerId,
  tally: Tally,
  seeding: Seeding
) =>
  Layer.build(
    Interpreter.layerWithImplementations(Steps, Step.toLayer(({ index }) => Effect.succeed(index))).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        EngineStore.layer({
          owner: { hostId: owner.hostId },
          journalSource: `${owner.hostId}-engine`,
          isAlive: (recorded, context) => Effect.succeed(recorded.hostId !== context.claimant.hostId),
          sweep: { host: "replay-cost" }
        }).pipe(Layer.provide(OwnerIdentity.layerConstant(owner)))
      ),
      Layer.provideMerge(Layer.mergeAll(StepBoundary.layerUnsupported, jj)),
      Layer.provideMerge(countingStores(tally, seeding)),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.merge(SqlJournal.layerWith({ capacity: 1024, overflow: "reject" }), RunStore.layerWith).pipe(
            Layer.provide(SqlConsensus.layer)
          ),
          AttemptStore.layer,
          CacheStore.layer,
          PlanStore.layer,
          PlanInputStore.layer,
          PlanMergeStore.layer,
          DurableEngineState.layer
        )
      ),
      Layer.provideMerge(Layer.succeedContext(database))
    )
  )

/** Runs `steps` steps and parks under one incarnation, then tallies the round that resumes it under the next. */
const resume = (steps: number, seeding: Seeding = "whole") =>
  Effect.gen(function*() {
    const database = yield* Layer.build(TestStores.database)
    const tally: Tally = { on: false, statements: 0, gets: 0, lists: 0, heartbeats: 0 }
    const options = { executionId: "replay-cost", payload: { steps } }
    const parked = yield* Effect.scoped(
      Effect.flatMap(incarnation(database, first, tally, seeding), (context) =>
        Effect.provide(EngineStore.drive(Steps, options), context))
    )
    yield* TestClock.adjust(Duration.minutes(10))
    return yield* Effect.scoped(
      Effect.flatMap(incarnation(database, second, tally, seeding), (context) =>
        Effect.gen(function*() {
          tally.on = true
          // Every statement the drive sends passes the transformer.
          const driven = yield* Effect.provide(EngineStore.drive(Steps, options), context).pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                tally.statements++
                return statement
              }))
          )
          tally.on = false
          return { parked, driven, tally }
        }))
    )
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

describe("a resumed run's replay", () => {
  it("costs the same whatever the number of steps it replays", () =>
    run(Effect.gen(function*() {
      const short = yield* resume(1)
      const long = yield* resume(8)
      for (const resumed of [short, long]) {
        expect(resumed.parked).toMatchObject({ _tag: "Parked" })
        expect(resumed.driven).toEqual({ _tag: "Settled", status: "completed" })
      }
      // The round reads the run's attempts once, and a replayed step neither
      // reads its row nor heartbeats the fence.
      expect(short.tally.statements).toBeGreaterThan(0)
      expect(long.tally.lists).toBe(1)
      expect(long.tally.gets).toBe(short.tally.gets)
      expect(long.tally.heartbeats).toBe(short.tally.heartbeats)
      expect(long.tally.statements).toBe(short.tally.statements)
    })), 120_000)

  it(
    "replays one read a step from a store that cannot read a run at once, and from one whose read fails",
    () =>
      run(Effect.gen(function*() {
        for (const seeding of ["absent", "failing"] as const) {
          const short = yield* resume(1, seeding)
          const long = yield* resume(8, seeding)
          expect(long.driven).toEqual({ _tag: "Settled", status: "completed" })
          expect(long.tally.lists).toBe(seeding === "absent" ? 0 : 1)
          // Each of the seven more steps reads its recorded row, and is still not fenced.
          expect(long.tally.gets - short.tally.gets).toBe(7)
          expect(long.tally.heartbeats).toBe(short.tally.heartbeats)
        }
      })),
    120_000
  )
})
