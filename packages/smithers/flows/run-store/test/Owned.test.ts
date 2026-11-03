/**
 * `RunStore.owned` is the fence an action adds to its own write. A write under
 * a fence lands only while the fenced owner holds the run and the fenced
 * attempt is still running; a takeover, a settled attempt, or a settled run
 * makes the same statement change nothing. On PostgreSQL the condition also
 * orders the write against a concurrent takeover: the takeover waits for the
 * fenced write's transaction, so a write never lands after the run moved on.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Context, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as AttemptStore from "../src/AttemptStore.vibe"
import * as Migrations from "../src/Migrations.vibe"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const pgUrl = process.env.SMITHERS_TEST_PG_URL

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const digest = "d".repeat(64)

type Stores = DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore.RunStore | AttemptStore.AttemptStore

const stores = <A, E>(effect: Effect.Effect<A, E, Stores>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(RunStore.layer, AttemptStore.layer)),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

/** Takes the run for `owner`; a running row is taken with same-host proof that its owner is gone. */
const own = (runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId)
    const nowMs = yield* Clock.currentTimeMillis
    const outcome = yield* store.claimAndOwn(
      runId,
      snapshot(row),
      owner,
      nowMs,
      row.owner === null ? undefined : { expectedOwner: row.owner, checkedAtMs: nowMs, kind: "same-host-pid-dead" }
    )
    expect(outcome).toEqual({ _tag: "Activated" })
  })

const startAttempt = (runId: string, attempt: number, owner: OwnerId) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const startedAtMs = yield* Clock.currentTimeMillis
    const put = yield* attempts.put(
      { runId, stepKeyDigest: digest, attempt, state: "running", startedAtMs, meta: {} },
      owner
    )
    expect(put).toEqual({ _tag: "Inserted" })
  })

const fence = (runId: string, attempt: number, owner: OwnerId): RunStore.Fence => ({
  runId,
  stepKeyDigest: digest,
  attempt,
  owner
})

/** The application table an action writes, outside the engine's own tables. */
const createMessages = (sql: SqlClient.SqlClient, table: string) =>
  sql`CREATE TABLE ${sql(table)} (id TEXT PRIMARY KEY, text TEXT NOT NULL)`

const readText = (sql: SqlClient.SqlClient, table: string, id: string) =>
  Effect.map(
    sql<{ readonly text: string }>`SELECT text FROM ${sql(table)} WHERE id = ${id}`,
    (rows) => rows[0]?.text
  )

/** A fenced write, answering how many rows it changed. */
const fencedWrite = (
  sql: SqlClient.SqlClient,
  table: string,
  id: string,
  text: string,
  current: RunStore.Fence,
  options?: RunStore.OwnedOptions
) =>
  Effect.map(
    sql<{ readonly id: string }>`
      UPDATE ${sql(table)} SET text = ${text}
      WHERE id = ${id} AND ${RunStore.owned(sql, current, options)}
      RETURNING id
    `,
    (rows) => rows.length
  )

describe("RunStore.owned", () => {
  it.effect("admits a write only while its owner holds the run and its attempt is running", () =>
    stores(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* RunStore.RunStore
      const attempts = yield* AttemptStore.AttemptStore
      yield* createMessages(sql, "fenced_messages")
      yield* sql`INSERT INTO fenced_messages (id, text) VALUES ('m1', '')`
      yield* store.create("run-fenced", "{}")
      yield* own("run-fenced", ownerA)
      yield* startAttempt("run-fenced", 1, ownerA)

      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "a1", fence("run-fenced", 1, ownerA))).toBe(1)
      // Another attempt number is not the running attempt.
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "a2", fence("run-fenced", 2, ownerA))).toBe(0)
      // Another step's digest is not this attempt either.
      expect(
        yield* fencedWrite(sql, "fenced_messages", "m1", "other-step", {
          ...fence("run-fenced", 1, ownerA),
          stepKeyDigest: "e".repeat(64)
        })
      ).toBe(0)

      // B takes the run over and adopts the attempt A left running.
      yield* own("run-fenced", ownerB)
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "stale", fence("run-fenced", 1, ownerA))).toBe(0)
      expect(yield* readText(sql, "fenced_messages", "m1")).toBe("a1")
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "b1", fence("run-fenced", 1, ownerB))).toBe(1)

      // The adopted attempt fails and a retry starts: the old attempt's fence
      // no longer admits a write, the new one does.
      const finishedAtMs = yield* Clock.currentTimeMillis
      expect(
        yield* attempts.finish(
          { runId: "run-fenced", stepKeyDigest: digest, attempt: 1, state: "failed", finishedAtMs },
          ownerB
        )
      ).toEqual({ _tag: "Finished" })
      yield* startAttempt("run-fenced", 2, ownerB)
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "late", fence("run-fenced", 1, ownerB))).toBe(0)
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "b2", fence("run-fenced", 2, ownerB))).toBe(1)

      // A run that left `running` admits nothing, even under its last owner.
      expect(yield* store.transitionOwned("run-fenced", ownerB, "suspended")).toEqual({ _tag: "Transitioned" })
      expect(yield* fencedWrite(sql, "fenced_messages", "m1", "parked", fence("run-fenced", 2, ownerB))).toBe(0)
      expect(yield* readText(sql, "fenced_messages", "m1")).toBe("b2")
    })))

  it.effect("refuses a fence for a run that does not exist", () =>
    stores(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createMessages(sql, "fenced_missing")
      yield* sql`INSERT INTO fenced_missing (id, text) VALUES ('m1', 'kept')`
      expect(yield* fencedWrite(sql, "fenced_missing", "m1", "written", fence("no-such-run", 1, ownerA))).toBe(0)
      expect(yield* readText(sql, "fenced_missing", "m1")).toBe("kept")
    })))

  it.effect("names the engine tables in the schema it is given", () =>
    stores(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* RunStore.RunStore
      yield* createMessages(sql, "fenced_qualified")
      yield* sql`INSERT INTO fenced_qualified (id, text) VALUES ('m1', '')`
      yield* store.create("run-qualified", "{}")
      yield* own("run-qualified", ownerA)
      yield* startAttempt("run-qualified", 1, ownerA)
      // SQLite names its own database `main`; PostgreSQL names the schema the
      // test database created.
      const schema = pgUrl === undefined
        ? "main"
        : (yield* sql.withTransaction(sql<{ readonly schema: string }>`SELECT current_schema() AS schema`))[0]!
          .schema
      expect(
        yield* fencedWrite(sql, "fenced_qualified", "m1", "qualified", fence("run-qualified", 1, ownerA), { schema })
      ).toBe(1)
      // A schema without the engine tables cannot vouch for any fence.
      const missing = yield* Effect.flip(
        fencedWrite(sql, "fenced_qualified", "m1", "nowhere", fence("run-qualified", 1, ownerA), {
          schema: "no_such_schema"
        })
      )
      expect(missing._tag).toBe("SqlError")
      expect(yield* readText(sql, "fenced_qualified", "m1")).toBe("qualified")
    })))

  it.skipIf(pgUrl === undefined)(
    "orders a fenced PostgreSQL write before a concurrent takeover from another client",
    () =>
      Effect.runPromise(stores(
        Effect.gen(function*() {
          const engineSql = yield* SqlClient.SqlClient
          const store = yield* RunStore.RunStore
          const engineSchema = (yield* engineSql.withTransaction(
            engineSql<{ readonly schema: string }>`SELECT current_schema() AS schema`
          ))[0]!.schema
          // The application keeps its own tables in its own scratch schema on
          // its own client, as a product beside the engine does, so its
          // transactions take that schema's writer lock and not the engine's.
          // Fresh, or the memo map hands back the engine's own client.
          const appSql = Context.get(yield* Layer.build(Layer.fresh(TestDatabase.layer)), SqlClient.SqlClient)
          yield* appSql.withTransaction(createMessages(appSql, "messages"))
          yield* appSql.withTransaction(appSql`INSERT INTO messages (id, text) VALUES ('m1', '')`)

          yield* store.create("run-ordered", "{}")
          yield* own("run-ordered", ownerA)
          yield* startAttempt("run-ordered", 1, ownerA)
          const fencedA = fence("run-ordered", 1, ownerA)

          const blockedByApp = (appPid: number) =>
            Effect.map(
              engineSql<{ readonly blocked: number }>`
              SELECT count(*)::int AS blocked FROM pg_stat_activity
              WHERE ${appPid} = ANY(pg_blocking_pids(pid))
            `,
              (rows) => rows[0]!.blocked > 0
            )

          const takeover = yield* appSql.withTransaction(Effect.gen(function*() {
            const appPid = (yield* appSql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid
            expect(yield* fencedWrite(appSql, "messages", "m1", "before-takeover", fencedA, { schema: engineSchema }))
              .toBe(1)
            // B's takeover starts while the fenced write's transaction is open,
            // and waits for it.
            const fiber = yield* Effect.forkChild(own("run-ordered", ownerB))
            yield* TestDatabase.until(blockedByApp(appPid))
            expect(fiber.pollUnsafe()).toBeUndefined()
            expect((yield* store.get("run-ordered")).owner).toEqual(ownerA)
            return fiber
          }))
          yield* Fiber.join(takeover)
          expect((yield* store.get("run-ordered")).owner).toEqual(ownerB)
          // The write committed before the takeover, and nothing from A lands after it.
          expect(yield* fencedWrite(appSql, "messages", "m1", "after-takeover", fencedA, { schema: engineSchema }))
            .toBe(0)
          expect(yield* readText(appSql, "messages", "m1")).toBe("before-takeover")
        }).pipe(Effect.scoped)
      ))
  )
})
