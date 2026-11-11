/**
 * `AttemptStore.listRun`: every attempt row of one run in one read, which a
 * resumed run's replay answers its recorded steps from instead of reading
 * each step's rows as it reaches it. Runs on the test database the matrix
 * selects: SQLite, or PostgreSQL under `SMITHERS_TEST_PG_URL`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { AttemptStore } from "../src/AttemptStore.vibe"
import * as AttemptStoreLive from "../src/AttemptStore.vibe"
import * as Migrations from "../src/Migrations.vibe"

const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/** The SQL statements the code under it builds, counted at the client. */
const counted = (count: { statements: number }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (base) =>
      new Proxy(base, {
        apply(target, receiver, args) {
          count.statements++
          return Reflect.apply(target, receiver, args) as Statement.Statement<unknown>
        }
      }))
  )

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | AttemptStore>
) =>
  effect.pipe(
    Effect.provide(AttemptStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

const createRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (${runId}, 'running', 1, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, '{}')
    `
  })

const put = (runId: string, stepKeyDigest: string, attempt: number, extra: Partial<AttemptStoreLive.Attempt> = {}) =>
  Effect.flatMap(
    AttemptStore,
    (store) =>
      store.put(
        { runId, stepKeyDigest, attempt, state: "running", startedAtMs: 10 + attempt, meta: {}, ...extra },
        owner
      )
  )

describe("AttemptStore.listRun", () => {
  it.effect("reads every attempt of one run, in step key and attempt order, exactly as get reads each", () =>
    migrated(Effect.gen(function*() {
      yield* createRun("run-1")
      yield* createRun("run-2")
      const store = yield* AttemptStore
      yield* put("run-1", "digest-b", 2, { checkpoint: { cursor: 2 } })
      yield* put("run-1", "digest-b", 1)
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-b",
        attempt: 1,
        state: "failed",
        finishedAtMs: 15,
        error: { _tag: "Boom" }
      }, owner)
      yield* put("run-1", "digest-a", 1, { meta: { tier: "sealed" } })
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-a",
        attempt: 1,
        state: "succeeded",
        finishedAtMs: 12,
        outcome: { value: "a" }
      }, owner)
      yield* put("run-2", "digest-a", 1)

      const listed = yield* store.listRun!("run-1")
      const each = yield* Effect.forEach(
        [["digest-a", 1], ["digest-b", 1], ["digest-b", 2]] as const,
        ([stepKeyDigest, attempt]) =>
          Effect.map(store.get({ runId: "run-1", stepKeyDigest, attempt }), Option.getOrThrow)
      )
      expect(listed).toEqual(each)
      expect(listed.map((row) => [row.stepKeyDigest, row.attempt, row.state])).toEqual([
        ["digest-a", 1, "succeeded"],
        ["digest-b", 1, "failed"],
        ["digest-b", 2, "running"]
      ])
      expect(yield* store.listRun!("run-3")).toEqual([])
    })))

  it.effect("is one statement however many attempts the run holds", () =>
    Effect.gen(function*() {
      const count = { statements: 0 }
      const statements = yield* Effect.gen(function*() {
        yield* createRun("run-1")
        for (let index = 0; index < 12; index++) yield* put("run-1", `digest-${index}`, 1)
        const store = yield* AttemptStore
        count.statements = 0
        const listed = yield* store.listRun!("run-1")
        expect(listed).toHaveLength(12)
        return count.statements
      }).pipe(
        Effect.provide(AttemptStoreLive.layer),
        Effect.provide(Layer.provideMerge(counted(count), Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
      )
      expect(statements).toBe(1)
    }))

  it.effect("refuses a run id outside the durable identifier contract", () =>
    migrated(Effect.gen(function*() {
      const store = yield* AttemptStore
      const failure = yield* Effect.flip(store.listRun!(""))
      expect(failure.code).toBe("invalid_attempt")
      expect(failure.method).toBe("listRun")
    })))

  it.effect("fails decode_failed on a corrupt row rather than listing part of the run", () =>
    migrated(Effect.gen(function*() {
      yield* createRun("run-1")
      yield* put("run-1", "digest-a", 1)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* TestDatabase.checks(sql, false)
      yield* sql.unsafe(`UPDATE flows_attempts SET meta_json = 'not-json' WHERE run_id = 'run-1'`)
      const store = yield* AttemptStore
      const failure = yield* Effect.flip(store.listRun!("run-1"))
      expect(failure.code).toBe("decode_failed")
      expect(failure.method).toBe("listRun")
    })))

  it.effect("names itself in a persistence failure", () =>
    Effect.gen(function*() {
      const sql = new Proxy(() => Effect.fail("down"), {
        apply: () => Effect.fail("down"),
        get: (target, property) => property === "in" ? () => "" : Reflect.get(target, property)
      }) as unknown as SqlClient.SqlClient
      const failure = yield* Effect.flip(
        Effect.flatMap(AttemptStore, (store) => store.listRun!("run-1")).pipe(
          Effect.provide(AttemptStoreLive.layer),
          Effect.provide(Layer.merge(
            Layer.succeed(SqlClient.SqlClient)(sql),
            Layer.succeed(DurableWriter.DurableWriter)(
              DurableWriter.DurableWriter.of({ write: () => Effect.die("no writes here") })
            )
          ))
        )
      )
      expect(failure.code).toBe("persistence_failed")
      expect(failure.message).toBe("persistence_failed: AttemptStore.listRun: attempt persistence failed")
    }))

  it("is absent from the closed stub, so a caller falls back to reading each attempt", () => {
    expect(AttemptStoreLive.makeNoop().listRun).toBeUndefined()
  })
})
