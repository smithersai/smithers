/**
 * Run revisions are bumped at COMMIT on PostgreSQL once run-store migration 1006
 * has run. These cases pin what readers still promise on that schema, whether or
 * not this binary's own migration set has 1006: a read inside a writer's
 * transaction sees its own writes' revisions, and a change-feed cursor resumed
 * across commits that land in any order misses no run. SQLite keeps immediate
 * triggers, so the cases need PostgreSQL.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { TestSchemas } from "@smthrs/database"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as PostgresDatabase from "@smthrs/database/postgres/PostgresDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import { Context, Duration, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Migrations from "../src/Migrations.vibe"
import * as RunChangeFeed from "../src/RunChangeFeed.vibe"
import { state } from "./ExecutionSnapshotFixture.ts"

const url = process.env.SMITHERS_TEST_PG_URL
const withRunStore = (
  change: (migrations: DatabaseMigrations.MigrationSet["migrations"]) => DatabaseMigrations.MigrationSet["migrations"]
) => Migrations.sets.map((set) => set.namespace === "run-store" ? { ...set, migrations: change(set.migrations) } : set)
/** Every set, with 1006: the schema after the release that activates it. */
const upgraded = withRunStore((migrations) => ({
  ...migrations,
  "0006_deferred_revisions": RunStoreMigrations.deferredRevisions
}))
/** Every set, without 1006: the binary production rolls back to. */
const rollbackTarget = withRunStore(({ "0006_deferred_revisions": _, ...migrations }) => migrations)
const database = Layer.provideMerge(Layer.effectDiscard(DatabaseMigrations.run(upgraded)), TestDatabase.layer)
const insert = (sql: SqlClient.SqlClient, runId: string) =>
  sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${runId}, 'pending', 1, ${state})`
const head = (sql: SqlClient.SqlClient) =>
  sql<{ revision: number }>`SELECT revision FROM flows_run_source`.pipe(
    Effect.map((rows) => Number(rows[0]!.revision))
  )

describe.skipIf(url === undefined)("deferred run revisions on PostgreSQL", () => {
  it.live("a read inside the writer's transaction sees its own insert, update and delete", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const reader = yield* ExecutionSnapshot.make()
      const before = (yield* reader.read(["mine"])).revision
      const seen = yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* insert(sql, "mine")
          const inserted = yield* reader.read(["mine"])
          yield* sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = 'mine'`
          const updated = yield* reader.read(["mine"])
          yield* sql`DELETE FROM flows_runs WHERE run_id = 'mine'`
          const deleted = yield* reader.read(["mine"])
          return { inserted, updated, deleted }
        }),
        { partition: "mine" }
      )
      // An insert bumps more than once here: engine-store's listing trigger updates the new row too.
      const inserted = seen.inserted.snapshots[0]!
      const updated = seen.updated.snapshots[0]!
      const deleted = seen.deleted.snapshots[0]!
      expect(inserted).toMatchObject({ _tag: "Observed", revision: seen.inserted.revision })
      expect(inserted.revision).toBeGreaterThan(before)
      expect(updated).toMatchObject({ _tag: "Observed", revision: seen.updated.revision })
      expect(updated.revision).toBeGreaterThan(inserted.revision)
      expect(deleted).toMatchObject({ _tag: "Missing", deleted: true, revision: seen.deleted.revision })
      expect(deleted.revision).toBeGreaterThan(updated.revision)
      // The read's revisions are the ones the commit kept.
      expect((yield* reader.read(["mine"])).snapshots[0]).toEqual(seen.deleted.snapshots[0])
      // Its own read put the writer's bumps back to COMMIT: a later write in the
      // same transaction still bumps there, not at its statement.
      const later = yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* insert(sql, "later")
          const read = (yield* reader.read(["later"])).revision
          yield* sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = 'later'`
          return { read, after: yield* head(sql) }
        }),
        { partition: "later" }
      )
      expect(later.after).toBe(later.read)
      expect(yield* head(sql)).toBe(later.read + 1)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("the feed's reads inside a writer's transaction see its write too", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const feed = yield* RunChangeFeed.make()
      const start = yield* feed.current
      const seen = yield* DurableWriter.make(sql).write(
        insert(sql, "joined").pipe(
          Effect.andThen(Effect.all({
            current: feed.current,
            changes: feed.changesSince({ source: start.source, revision: start.revision, limit: 10 })
          }))
        ),
        { partition: "joined" }
      )
      expect(seen.current.revision).toBeGreaterThan(start.revision)
      expect(seen.changes.changes.map((change) => change.runId)).toEqual(["joined"])
      expect(seen.changes.nextRevision).toBe(seen.current.revision)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("a read that returns only the watermark still flushes in order, so no tombstone goes wrong", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const feed = yield* RunChangeFeed.make()
      const reader = yield* ExecutionSnapshot.make()
      yield* insert(sql, "recreated")
      const start = yield* feed.current
      yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* sql`DELETE FROM flows_runs WHERE run_id = 'recreated'`
          yield* insert(sql, "recreated")
          yield* insert(sql, "born")
          yield* sql`DELETE FROM flows_runs WHERE run_id = 'born'`
          yield* feed.current
        }),
        { partition: "mixed" }
      )
      const batch = yield* reader.read(["recreated", "born"])
      expect(batch.snapshots[0]).toMatchObject({ _tag: "Observed", runId: "recreated" })
      expect(batch.snapshots[1]).toMatchObject({ _tag: "Missing", runId: "born", deleted: true })
      const page = yield* feed.changesSince({ source: start.source, revision: start.revision, limit: 10 })
      expect(page.changes.map(({ deleted, runId }) => [runId, deleted]).sort()).toEqual([
        ["born", true],
        ["recreated", false]
      ])
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("the rollback target runs on the upgraded schema: it migrates nothing and reads its own writes", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const reader = yield* ExecutionSnapshot.make()
      const feed = yield* RunChangeFeed.make()
      // The target on its own schema: immediate bumps, so the flush has nothing to do.
      yield* DatabaseMigrations.run(rollbackTarget)
      yield* insert(sql, "before")
      const earlier = yield* DurableWriter.make(sql).write(
        insert(sql, "immediate").pipe(Effect.andThen(reader.read(["immediate"]))),
        { partition: "immediate" }
      )
      expect(earlier.snapshots[0]).toMatchObject({ _tag: "Observed", revision: earlier.revision })
      // The release with 1006 upgrades the schema, then production rolls back.
      expect(yield* DatabaseMigrations.run(upgraded)).toEqual([[1006, "run-store_deferred_revisions"]])
      expect(yield* DatabaseMigrations.run(rollbackTarget)).toEqual([])
      const start = yield* feed.current
      const seen = yield* DurableWriter.make(sql).write(
        Effect.gen(function*() {
          yield* insert(sql, "mine")
          const inserted = yield* reader.read(["mine"])
          yield* sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = 'mine'`
          const updated = yield* reader.read(["mine"])
          yield* insert(sql, "gone")
          yield* sql`DELETE FROM flows_runs WHERE run_id = 'gone'`
          const deleted = yield* reader.read(["gone"])
          return { inserted, updated, deleted }
        }),
        { partition: "mine" }
      )
      expect(seen.inserted.snapshots[0]).toMatchObject({ _tag: "Observed", revision: seen.inserted.revision })
      expect(seen.updated.snapshots[0]).toMatchObject({ _tag: "Observed", revision: seen.updated.revision })
      expect(seen.updated.revision).toBeGreaterThan(seen.inserted.revision)
      expect(seen.deleted.snapshots[0]).toMatchObject({
        _tag: "Missing",
        deleted: true,
        revision: seen.deleted.revision
      })
      const page = yield* feed.changesSince({ source: start.source, revision: start.revision, limit: 10 })
      expect(page.changes.map(({ deleted, runId }) => [runId, deleted]).sort()).toEqual([["gone", true], [
        "mine",
        false
      ]])
      expect((yield* reader.read(["before"])).snapshots[0]).toMatchObject({ _tag: "Observed" })
    }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped))

  it.live("a read in its own read-only transaction still works, with nothing to flush", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const reader = yield* ExecutionSnapshot.make()
      yield* insert(sql, "committed")
      const batch = yield* ExecutionSnapshot.withReadTransaction(sql, reader.read(["committed"]))
      expect(batch.snapshots[0]).toMatchObject({ _tag: "Observed", revision: batch.revision })
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("a resumed change-feed cursor pages every run across commits that land out of order", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const feed = yield* RunChangeFeed.make()
      const ids = Array.from({ length: 12 }, (_, index) => `paged-${index}`)
      yield* Effect.forEach(ids, (runId) => insert(sql, runId), { discard: true })
      const start = yield* feed.current
      // Each writer updates its run at once and commits after a different
      // delay, so commit order differs from write order.
      const writers = yield* Effect.forEach(
        ids,
        (runId, index) =>
          DurableWriter.make(sql).write(
            sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = ${runId}`.pipe(
              Effect.andThen(Effect.sleep(Duration.millis(((index * 7) % 12) * 25)))
            ),
            { partition: runId }
          ),
        { concurrency: "unbounded", discard: true }
      ).pipe(Effect.forkChild)
      const seen = new Map<string, number>()
      let cursor = start.revision
      const page = Effect.gen(function*() {
        const result = yield* feed.changesSince({ source: start.source, revision: cursor, limit: 3 })
        let last = cursor
        for (const change of result.changes) {
          expect(change.revision).toBeGreaterThan(last)
          last = change.revision
          seen.set(change.runId, change.revision)
        }
        cursor = result.nextRevision
        return result.hasMore
      })
      while (writers.pollUnsafe() === undefined) {
        yield* page
        yield* Effect.sleep(Duration.millis(10))
      }
      yield* Fiber.join(writers)
      while (yield* page) {
        // Drain the pages left after the last commit.
      }
      expect([...seen.keys()].sort()).toEqual([...ids].sort())
      for (const revision of seen.values()) expect(revision).toBeGreaterThan(start.revision)
      expect(cursor).toBe((yield* feed.current).revision)
    }).pipe(Effect.provide(database), Effect.scoped))

  it.live("the connection that ran the migrations writes with deferred bumps afterwards", () =>
    Effect.gen(function*() {
      // One connection, so the write below reuses the one the migration pass ran on.
      const schema = TestSchemas.schemaName("revision_reuse")
      const sql = Context.get(
        yield* Layer.build(PostgresDatabase.layer({ url: url!, driver: Pg, schema, postgres: { maxConnections: 1 } })),
        SqlClient.SqlClient
      )
      yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
      yield* DatabaseMigrations.run(upgraded).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      yield* insert(sql, "reused")
      const before = yield* head(sql)
      const inside = yield* DurableWriter.make(sql).write(
        sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = 'reused'`.pipe(Effect.andThen(head(sql))),
        { partition: "reused" }
      )
      // An immediate bump would show inside the transaction; a deferred one shows at COMMIT.
      expect(inside).toBe(before)
      expect(yield* head(sql)).toBe(before + 1)
    }).pipe(Effect.scoped))
})
