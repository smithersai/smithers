import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

const layer = RunStore.layer.pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

describe("lineage admission", () => {
  it.effect("preserves duplicate run-id constraints when retrying an existing later round", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      yield* runs.create("root", "{}")
      const options = { lineageId: "root", parentRunId: "root", roundOrdinal: 1 }
      yield* runs.create("next", "{}", options)
      expect((yield* Effect.flip(runs.create("next", "{}", options))).code).toBe("constraint")
      expect((yield* runs.latestRound("root")).runId).toBe("next")
      expect(yield* runs.lineage("root")).toHaveLength(2)
    }).pipe(Effect.provide(layer)))

  it.effect("rejects a missing root, unrelated root, or parent outside the lineage", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      yield* runs.create("victim", "{}")
      yield* runs.create("other", "{}")
      yield* runs.create("other-round", "{}", { lineageId: "other", parentRunId: "other", roundOrdinal: 1 })
      const cases: ReadonlyArray<RunStore.CreateOptions> = [
        { lineageId: "missing", parentRunId: "victim", roundOrdinal: 1 },
        { lineageId: "other-round", parentRunId: "other-round", roundOrdinal: 2 },
        { lineageId: "victim", roundOrdinal: 1 },
        { lineageId: "victim", parentRunId: "missing", roundOrdinal: 1 },
        { lineageId: "victim", parentRunId: "other", roundOrdinal: 1 },
        { lineageId: "victim", parentRunId: "other-round", roundOrdinal: 2 }
      ]
      for (const [index, options] of cases.entries()) {
        const id = `rejected-${index}`
        expect(yield* Effect.flip(runs.create(id, "{}", options))).toMatchObject({
          code: "invalid_run",
          method: "create"
        })
        expect((yield* Effect.flip(runs.get(id))).code).toBe("not_found_row")
        expect(yield* runs.requestCancelLineage(id, 100)).toEqual({ _tag: "NotFound" })
      }
      expect((yield* runs.latestRound("victim")).runId).toBe("victim")
      expect((yield* runs.lineage("victim")).map((row) => row.runId)).toEqual(["victim"])
      expect((yield* runs.get("victim")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.provide(layer)))

  it.effect("counts an implicit root as round zero and requires a strictly increasing ordinal", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      for (const explicit of [false, true]) {
        const root = explicit ? "explicit" : "implicit"
        yield* runs.create(root, "{}", explicit ? { lineageId: root, roundOrdinal: 0 } : undefined)
        expect(
          (yield* Effect.flip(runs.create(`${root}-zero`, "{}", {
            lineageId: root,
            parentRunId: root,
            roundOrdinal: 0
          }))).code
        ).toBe("invalid_run")
        yield* runs.create(`${root}-next`, "{}", { lineageId: root, parentRunId: root, roundOrdinal: 3 })
        for (const roundOrdinal of [0, 1, 2, 3]) {
          expect(
            (yield* Effect.flip(runs.create(`${root}-bad-${roundOrdinal}`, "{}", {
              lineageId: root,
              parentRunId: root,
              roundOrdinal
            }))).code
          ).toBe("invalid_run")
        }
        yield* runs.create(`${root}-last`, "{}", {
          lineageId: root,
          parentRunId: `${root}-next`,
          roundOrdinal: 4
        })
        expect((yield* runs.lineage(root)).map((row) => row.runId)).toEqual([
          root,
          `${root}-next`,
          `${root}-last`
        ])
        expect((yield* runs.latestRound(root)).runId).toBe(`${root}-last`)
      }
    }).pipe(Effect.provide(layer)))

  it.effect("serializes competing next-round admissions across different run ids", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      yield* runs.create("root", "{}")
      const results = yield* Effect.all(
        ["a", "b"].map((id) =>
          Effect.result(runs.create(id, "{}", {
            lineageId: "root",
            parentRunId: "root",
            roundOrdinal: 1
          }))
        ),
        { concurrency: "unbounded" }
      )
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      const failure = results.find((result) => result._tag === "Failure")
      expect(failure).toMatchObject({ failure: { code: "invalid_run" } })
      expect(yield* runs.lineage("root")).toHaveLength(2)
    }).pipe(Effect.provide(layer)))
})

it.skipIf(process.env.SMITHERS_TEST_PG_URL === undefined)(
  "serializes lineage admission across independent PostgreSQL writers",
  () =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const sql = yield* SqlClient.SqlClient
        const writer = yield* DurableWriter.DurableWriter
        const driver = yield* Effect.promise(() => import("@effect/sql-pg"))
        const schema = (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema
        const peer = Context.get(
          yield* Layer.build(Layer.fresh(RunStore.layer.pipe(
            Layer.provideMerge(DurableWriter.layer()),
            Layer.provide(PostgresDatabase.layer({
              url: process.env.SMITHERS_TEST_PG_URL!,
              driver,
              schema,
              // A wrong per-run lock must not retry its admitted INSERT after
              // the higher round commits and accidentally pass this test.
              writerLockTimeout: Duration.infinity
            }))
          ))),
          RunStore.RunStore
        )
        expect(peer).not.toBe(runs)
        yield* runs.create("root", "{}")
        const inserted = yield* Deferred.make<number>()
        const release = yield* Deferred.make<void>()
        const heldWriter: DurableWriter.Service = {
          ...writer,
          write: (effect, options) =>
            writer.write(
              effect.pipe(Effect.tap(() =>
                Effect.gen(function*() {
                  const pid = (yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid
                  yield* Deferred.succeed(inserted, pid)
                  yield* Deferred.await(release)
                })
              )),
              options
            )
        }
        const held = Context.get(
          yield* Layer.build(Layer.fresh(RunStore.layer.pipe(
            Layer.provide(Layer.succeed(DurableWriter.DurableWriter, heldWriter)),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))
          ))),
          RunStore.RunStore
        )
        expect(held).not.toBe(runs)
        expect(held).not.toBe(peer)
        const first = yield* Effect.forkChild(held.create("high", "{}", {
          lineageId: "root",
          parentRunId: "root",
          roundOrdinal: 3
        }))
        const firstPid = yield* Deferred.await(inserted).pipe(Effect.timeout("10 seconds"))
        const second = yield* Effect.forkChild(Effect.result(peer.create("low", "{}", {
          lineageId: "root",
          parentRunId: "root",
          roundOrdinal: 1
        })))
        // Wait until the second connection is blocked by the first transaction.
        // With a wrong per-run lock it has already admitted round 1 and is held
        // by the run-source trigger; with the global lock it has not read yet.
        yield* TestDatabase.until(Effect.map(
          sql<{ blocked: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE ${firstPid} = ANY(pg_blocking_pids(pid))) AS blocked
    `,
          (rows) => rows[0]!.blocked
        )).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(first)
        expect(yield* Fiber.join(second)).toMatchObject({ failure: { code: "invalid_run" } })
        expect((yield* runs.lineage("root")).map((row) => row.runId)).toEqual(["root", "high"])
      })).pipe(Effect.provide(layer))
    )
)
