/**
 * Every write to a run row bumps the one `flows_run_source` revision. On
 * PostgreSQL that bump must not hold the singleton's row lock across the
 * writer's later round trips: on smithers.sh, 2026-11-02, one transaction
 * idle between statements held it while 40 to 46 writers of other runs
 * (journal inserts through the progress trigger, claims, heartbeats,
 * transitions) waited on its transaction id. The bump runs at COMMIT, so
 * the lock lives for the commit alone and revisions still follow commit
 * order. SQLite serializes every write on its file lock, so these cases
 * need PostgreSQL.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.vibe"

const url = process.env.SMITHERS_TEST_PG_URL
// These cases need the deferred triggers, whether or not the release's set has 1006 yet.
const upgraded = {
  ...Migrations.set,
  migrations: { ...Migrations.set.migrations, "0006_deferred_revisions": Migrations.deferredRevisions }
}
const database = Layer.provideMerge(
  Layer.effectDiscard(DatabaseMigrations.run([JournalMigrations.set, upgraded])),
  TestDatabase.layer
)
const runs = Array.from({ length: 6 }, (_, index) => `run-${index}`)
/** How long each writer stays open after its first statement: one slow Hyperdrive round trip. */
const holdMs = 400

const revisionOf = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{ revision: number; deleted: number }>`SELECT revision, deleted FROM flows_run_changes WHERE run_id = ${runId}`
    .pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : { revision: Number(rows[0].revision), deleted: Number(rows[0].deleted) }
      )
    )
const head = (sql: SqlClient.SqlClient) =>
  sql<{ revision: number }>`SELECT revision FROM flows_run_source`.pipe(
    Effect.map((rows) => Number(rows[0]!.revision))
  )
const insertRuns = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  Effect.forEach(
    ids,
    (runId) =>
      sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${runId}, 'pending', 1, '{}')`,
    {
      discard: true
    }
  )

/**
 * Runs one write per run, each holding `holdMs` after `statement`. Each write
 * has its own writer and names its run's partition, as each run's Durable
 * Object alarm does, so only the database's row locks can order them.
 *
 * A sampler polls these writers' own backends through most of the hold, so
 * other suites sharing the server add no noise. It stops before the first
 * COMMIT: the commits themselves still take the revision row one at a time, for
 * milliseconds each, and `elapsedMs` bounds that queue.
 */
const convoy = (statement: (sql: SqlClient.SqlClient, runId: string) => Effect.Effect<unknown, unknown>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const started = Date.now()
    const backends: Array<number> = []
    const writers = yield* Effect.forEach(
      runs,
      (runId) =>
        DurableWriter.make(sql).write(
          Effect.gen(function*() {
            const [backend] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
            backends.push(Number(backend!.pid))
            const begun = Date.now()
            yield* statement(sql, runId)
            const waitedMs = Date.now() - begun
            yield* Effect.sleep(Duration.millis(holdMs))
            return waitedMs
          }),
          { partition: runId }
        ),
      { concurrency: "unbounded" }
    ).pipe(Effect.forkChild)
    let samples = 0
    let maxLockWaiters = 0
    while (Date.now() - started < holdMs * 0.75) {
      yield* Effect.sleep(Duration.millis(20))
      if (backends.length === 0) continue
      const [row] = yield* sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND pid IN ${sql.in(backends)}
      `
      samples += 1
      maxLockWaiters = Math.max(maxLockWaiters, Number(row!.waiting))
    }
    const waits = yield* Fiber.join(writers)
    const elapsedMs = Date.now() - started
    const sorted = [...waits].sort((left, right) => left - right)
    return {
      elapsedMs,
      samples,
      maxLockWaiters,
      waitedMs: sorted,
      blocked: sorted.filter((ms) => ms >= holdMs / 2).length
    }
  })

describe.skipIf(url === undefined)("run revision contention on PostgreSQL", () => {
  it.live("writers of different run rows do not queue behind each other's open transaction", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, runs)
      const before = yield* head(sql)
      const result = yield* convoy((sql, runId) => sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = ${runId}`)
      console.log(`run-row writers: ${JSON.stringify(result)}`)
      expect(result.samples).toBeGreaterThan(0)
      expect(result.maxLockWaiters).toBe(0)
      expect(result.blocked).toBe(0)
      expect(result.elapsedMs).toBeLessThan(holdMs * 2)
      expect(yield* head(sql)).toBe(before + runs.length)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("journal inserts of different runs do not queue through the progress trigger", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, runs)
      const before = yield* head(sql)
      const result = yield* convoy((sql, runId) =>
        sql`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (${runId}, 0, ${`${runId}-event`}, 'convoy', 0, 1, 'agent.turn', '{}', '{}')`
      )
      console.log(`journal writers: ${JSON.stringify(result)}`)
      expect(result.samples).toBeGreaterThan(0)
      expect(result.maxLockWaiters).toBe(0)
      expect(result.blocked).toBe(0)
      expect(result.elapsedMs).toBeLessThan(holdMs * 2)
      expect(yield* head(sql)).toBe(before + runs.length)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("revisions follow commit order, so a cursor read between commits misses nothing", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, ["first", "second"])
      const updated = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // `first` writes before `second` but commits after it.
      const first = yield* DurableWriter.make(sql).write(
        sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = 'first'`.pipe(
          Effect.andThen(Deferred.succeed(updated, undefined)),
          Effect.andThen(Deferred.await(release))
        ),
        { partition: "first" }
      ).pipe(Effect.forkChild)
      yield* Deferred.await(updated)
      yield* DurableWriter.make(sql).write(
        sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = 'second'`,
        { partition: "second" }
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () => Effect.die("the second run's writer waited for the first run's open transaction")
        }),
        Effect.onError(() => Deferred.succeed(release, undefined))
      )
      const cursor = yield* head(sql)
      expect((yield* revisionOf(sql, "second"))?.revision).toBe(cursor)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect((yield* revisionOf(sql, "first"))?.revision).toBeGreaterThan(cursor)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("a rolled back savepoint drops its bumps and the outer commit keeps its own", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, ["kept", "dropped"])
      const kept = (yield* revisionOf(sql, "kept"))!.revision
      const dropped = (yield* revisionOf(sql, "dropped"))!.revision
      const before = yield* head(sql)
      yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = 'kept'`
          const failed = yield* Effect.exit(sql.withTransaction(
            sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = 'dropped'`.pipe(
              Effect.andThen(Effect.fail("rolled back"))
            )
          ))
          expect(failed._tag).toBe("Failure")
        }),
        { partition: "kept" }
      )
      expect(yield* head(sql)).toBe(before + 1)
      expect((yield* revisionOf(sql, "kept"))!.revision).toBeGreaterThan(kept)
      expect((yield* revisionOf(sql, "dropped"))!.revision).toBe(dropped)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("a deleted run keeps its tombstone and a recreated one moves past it", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, ["phoenix", "churn"])
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'phoenix'`
      const tombstone = (yield* revisionOf(sql, "phoenix"))!
      expect(tombstone.deleted).toBe(1)
      yield* insertRuns(sql, ["phoenix"])
      const reborn = (yield* revisionOf(sql, "phoenix"))!
      expect(reborn.deleted).toBe(0)
      expect(reborn.revision).toBeGreaterThan(tombstone.revision)
      // Delete and recreate in one transaction: the bumps fire in event order at COMMIT, so the last one wins.
      yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* sql`DELETE FROM flows_runs WHERE run_id = 'churn'`
          yield* insertRuns(sql, ["churn"])
        }),
        { partition: "churn" }
      )
      expect((yield* revisionOf(sql, "churn"))!.deleted).toBe(0)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("an insert that does nothing on conflict bumps nothing and one that updates bumps once", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuns(sql, ["taken"])
      const before = yield* head(sql)
      const nothing = yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('taken', 'pending', 1, '{}') ON CONFLICT (run_id) DO NOTHING RETURNING run_id`
      expect(nothing).toEqual([])
      expect(yield* head(sql)).toBe(before)
      const updated = yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('taken', 'pending', 1, '{}') ON CONFLICT (run_id) DO UPDATE SET state_json = excluded.state_json
        RETURNING run_id`
      expect(updated).toEqual([{ run_id: "taken" }])
      expect(yield* head(sql)).toBe(before + 1)
      expect((yield* revisionOf(sql, "taken"))!.revision).toBe(before + 1)
    }).pipe(Effect.provide(database), Effect.scoped))

  describe("a flush before COMMIT", () => {
    type Operation = "insert" | "update" | "delete"
    const apply = (sql: SqlClient.SqlClient, [runId, operation]: readonly [string, Operation]) =>
      operation === "insert" ?
        insertRuns(sql, [runId]) :
        operation === "update" ?
        sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = ${runId}` :
        sql`DELETE FROM flows_runs WHERE run_id = ${runId}`
    // Each run's last operation decides its change row, and every order of the
    // three triggers misreads one of these if events fire grouped by trigger.
    const interleavings: ReadonlyArray<
      readonly [string, ReadonlyArray<string>, ReadonlyArray<readonly [string, Operation]>]
    > = [
      ["one run after another", ["recreated", "updated"], [
        ["recreated", "delete"],
        ["recreated", "insert"],
        ["born", "insert"],
        ["born", "delete"],
        ["updated", "update"],
        ["updated", "delete"]
      ]],
      ["the other way round", ["recreated", "updated"], [
        ["updated", "delete"],
        ["born", "insert"],
        ["born", "delete"],
        ["recreated", "delete"],
        ["recreated", "insert"],
        ["recreated", "update"]
      ]],
      ["statements interleaved", ["recreated", "updated"], [
        ["recreated", "delete"],
        ["born", "insert"],
        ["updated", "update"],
        ["recreated", "insert"],
        ["born", "delete"],
        ["updated", "delete"]
      ]]
    ]
    for (const [name, existing, operations] of interleavings) {
      it.live(`keeps each run's last operation, in order: ${name}`, () =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* insertRuns(sql, existing)
          yield* DurableWriter.make(sql).write(
            Effect.gen(function*() {
              for (const operation of operations) yield* apply(sql, operation)
              yield* Dialect.flushDeferredTriggers(sql, Migrations.revisionTriggers)
            }),
            { partition: "mixed" }
          )
          const last = new Map(operations)
          const order = [...new Set([...operations].reverse().map(([runId]) => runId))].reverse()
          const rows = yield* Effect.forEach(order, (runId) =>
            Effect.map(revisionOf(sql, runId), (row) => ({ runId, ...row! })))
          expect(rows.map(({ deleted, runId }) => [runId, deleted])).toEqual(
            order.map((runId) => [runId, last.get(runId) === "delete" ? 1 : 0])
          )
          // Revisions run in the order those last operations ran.
          expect(
            [...rows].sort((left, right) =>
              left.revision - right.revision
            ).map(({ runId }) => runId)
          ).toEqual(order)
        }).pipe(Effect.provide(database), Effect.scoped))
    }

    it.live("leaves later writes of the transaction to COMMIT, and a second flush keeps them in order", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* DurableWriter.make(sql).write(
          Effect.gen(function*() {
            yield* insertRuns(sql, ["first"])
            yield* Dialect.flushDeferredTriggers(sql, Migrations.revisionTriggers)
            const flushed = yield* head(sql)
            yield* sql`DELETE FROM flows_runs WHERE run_id = 'first'`
            yield* insertRuns(sql, ["second"])
            expect(yield* head(sql)).toBe(flushed)
            yield* Dialect.flushDeferredTriggers(sql, Migrations.revisionTriggers)
            expect(yield* head(sql)).toBe(flushed + 2)
            yield* sql`DELETE FROM flows_runs WHERE run_id = 'second'`
          }),
          { partition: "mixed" }
        )
        expect((yield* revisionOf(sql, "first"))!.deleted).toBe(1)
        expect((yield* revisionOf(sql, "second"))!.deleted).toBe(1)
      }).pipe(Effect.provide(database), Effect.scoped))
  })
})
