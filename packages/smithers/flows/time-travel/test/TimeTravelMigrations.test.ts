import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const database = (filename: string) => Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

const withDatabase = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient | DurableWriter.DurableWriter>
) => Effect.scoped(effect.pipe(Effect.provide(database(filename))))

describe("time-travel migrations", () => {
  it.effect("upgrades an old reclaimed intent to pending lane removal without losing its ordinal", () =>
    Effect.gen(function*() {
      yield* EngineMigrations.run
      yield* DatabaseMigrations.run([{
        ...Migrations.set,
        migrations: Object.fromEntries(Object.entries(Migrations.set.migrations).filter(([key]) => key < "0006"))
      }])
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_time_travel_fork_intents VALUES ('legacy', 'parent', 0, 0, 1)`
      yield* Migrations.run
      const store = yield* SqlTimeTravelStore.make
      expect(yield* sql`SELECT forgotten_at_ms FROM flows_time_travel_fork_intents`).toEqual([{
        forgotten_at_ms: null
      }])
      const intents = yield* store.abandonForkIntents(0)
      expect(intents).toEqual([{
        childRunId: "legacy",
        parentRunId: "parent",
        parentSeq: 0,
        reservedAtMs: 0,
        reclaimedAtMs: 2
      }])
      yield* store.forgetForkIntent("legacy", intents[0]!.reclaimedAtMs!)
      expect(yield* store.abandonForkIntents(1)).toEqual([])
      expect(yield* store.nextForkId("parent", { lineageId: "parent/root", seq: 0 })).toBe("parent:fork:0:2")
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("keeps the initial rung independent of later schema changes", () =>
    Effect.gen(function*() {
      yield* EngineMigrations.run
      yield* Migrations.set.migrations["0001_initial"]!
      const sql = yield* SqlClient.SqlClient
      const snapshots = yield* Dialect.columns(sql, "flows_time_travel_snapshots")
      const archive = yield* Dialect.columns(sql, "flows_time_travel_archive")
      const indexes = yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name IN
        ('flows_journal_events_child_spawn_idx', 'flows_journal_events_handoff_idx')`
      expect(snapshots.map((column) => column.name)).not.toContain("plan_digest")
      expect(archive.map((column) => column.name)).not.toContain("generation")
      expect(indexes).toEqual([])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("records every rung when the store builds and skips completed DDL", () =>
    Effect.gen(function*() {
      yield* EngineMigrations.run
      yield* SqlTimeTravelStore.make
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly migration_id: number }>`SELECT migration_id
        FROM flows_migrations WHERE migration_id >= 5000 ORDER BY migration_id`
      expect(rows.map((row) => row.migration_id)).toEqual([5001, 5002, 5003, 5004, 5005, 5006, 5007])
      // A completed rung is not a schema repair hook on each store build.
      yield* sql`DROP INDEX flows_journal_events_child_spawn_idx`
      yield* SqlTimeTravelStore.make
      const indexes = yield* sql`SELECT name FROM ${
        TestDatabase.catalog(sql)
      } WHERE name = 'flows_journal_events_child_spawn_idx'`
      expect(indexes).toEqual([])
    }).pipe(Effect.provide(TestDatabase.layer)))

  for (const door of ["ladder", "store"] as const) {
    it.effect(`adds run-scoped journal indexes to an existing database through the ${door}`, () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-indexes-")))
        try {
          const indexes = yield* withDatabase(
            join(directory, "indexes.sqlite"),
            Effect.gen(function*() {
              yield* EngineMigrations.run
              yield* DatabaseMigrations.run([{
                ...Migrations.set,
                migrations: {
                  "0001_initial": Migrations.set.migrations["0001_initial"]!,
                  "0002_archive_generation": Migrations.set.migrations["0002_archive_generation"]!
                }
              }])
              const sql = yield* SqlClient.SqlClient
              if (door === "ladder") yield* Migrations.run
              else yield* SqlTimeTravelStore.make
              return yield* sql<{ readonly name: string; readonly sql: string }>`
              SELECT name, sql FROM ${TestDatabase.catalog(sql)} WHERE type = 'index'
              AND name IN ('flows_journal_events_child_spawn_idx', 'flows_journal_events_handoff_idx')
              ORDER BY name`
            })
          )
          expect(indexes.map((index) => index.name)).toEqual([
            "flows_journal_events_child_spawn_idx",
            "flows_journal_events_handoff_idx"
          ])
          for (const index of indexes) {
            expect(index.sql).toContain("(run_id, seq)")
            expect(index.sql).toContain("WHERE event_type =")
            expect(index.sql).toContain("json_extract(payload_json,")
          }
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }))
  }

  for (const door of ["ladder", "store"] as const) {
    for (const columnAlreadyPresent of [false, true]) {
      it.effect(`upgrades recorded rungs through the ${door} with plan_digest present=${columnAlreadyPresent}`, () =>
        Effect.gen(function*() {
          yield* EngineMigrations.run
          yield* DatabaseMigrations.run([{
            ...Migrations.set,
            migrations: Object.fromEntries(
              Object.entries(Migrations.set.migrations).filter(([key]) => key < "0004_plan_digest")
            )
          }])
          const sql = yield* SqlClient.SqlClient
          if (columnAlreadyPresent) {
            // The old mutable initial rung installed this without a ledger row.
            yield* sql`ALTER TABLE flows_time_travel_snapshots ADD COLUMN plan_digest TEXT`
          }
          yield* sql`INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id)
            VALUES ('run', 'lineage', 0, 'change')`
          if (columnAlreadyPresent) {
            yield* sql`UPDATE flows_time_travel_snapshots SET plan_digest = 'existing-plan'`
          }
          if (door === "ladder") yield* Migrations.run
          else yield* SqlTimeTravelStore.make
          expect(yield* sql`SELECT change_id, plan_digest FROM flows_time_travel_snapshots`).toEqual([{
            change_id: "change",
            plan_digest: columnAlreadyPresent ? "existing-plan" : null
          }])
          expect(yield* sql`SELECT migration_id, name FROM flows_migrations WHERE migration_id = 5004`).toEqual([{
            migration_id: 5004,
            name: "time-travel_plan_digest"
          }])
        }).pipe(Effect.provide(TestDatabase.layer)))
    }
  }

  it.effect("adopts the complete unrecorded schema created by older store builds", () =>
    Effect.gen(function*() {
      yield* EngineMigrations.run
      for (const migration of Object.values(Migrations.set.migrations)) yield* migration
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_time_travel_snapshots VALUES ('run', 'lineage', 0, 'change', 'plan', 'operation')`
      yield* SqlTimeTravelStore.make
      expect(yield* sql`SELECT change_id, plan_digest, operation_id FROM flows_time_travel_snapshots`).toEqual([{
        change_id: "change",
        plan_digest: "plan",
        operation_id: "operation"
      }])
      const rows = yield* sql<{ readonly migration_id: number }>`SELECT migration_id FROM flows_migrations
        WHERE migration_id >= 5000 ORDER BY migration_id`
      expect(rows.map((row) => row.migration_id)).toEqual([5001, 5002, 5003, 5004, 5005, 5006, 5007])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("widens a legacy snapshots table that predates plan_digest", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-legacy-")))
      const filename = join(directory, "legacy.sqlite")
      try {
        const columns = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
            CREATE TABLE flows_time_travel_snapshots (
              run_id TEXT NOT NULL,
              lineage_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              change_id TEXT NOT NULL,
              PRIMARY KEY (run_id, lineage_id, seq)
            )
          `
            yield* SqlTimeTravelStore.migrate
            return yield* Dialect.columns(sql, "flows_time_travel_snapshots")
          })
        )

        expect(columns.map((column) => column.name)).toContain("plan_digest")
        expect(columns.map((column) => column.name)).toContain("operation_id")
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("rekeys a legacy archive that predates the journal generation", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-archive-")))
      const filename = join(directory, "archive.sqlite")
      try {
        const { columns, rows, generations } = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
            CREATE TABLE flows_time_travel_archive (
              run_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              event_id TEXT NOT NULL,
              source_id TEXT NOT NULL,
              source_seq INTEGER NOT NULL,
              emitted_at_ms INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              meta_json TEXT NOT NULL,
              archived_at_ms INTEGER NOT NULL,
              PRIMARY KEY (run_id, seq)
            )
          `
            yield* sql`
            INSERT INTO flows_time_travel_archive
            VALUES ('legacy', 1, 'legacy-1', 'source', 1, 0, 'type', '{}', '{}', 0)
          `
            yield* DatabaseMigrations.run([{
              ...Migrations.set,
              migrations: { "0001_initial": Migrations.set.migrations["0001_initial"]! }
            }])
            yield* Migrations.run
            // A rerun must find the rebuilt table and leave it alone.
            yield* SqlTimeTravelStore.migrate
            return {
              generations: yield* sql`SELECT run_id, generation FROM flows_journal_generations`,
              columns: yield* Dialect.columns(sql, "flows_time_travel_archive"),
              rows: yield* sql<{ readonly generation: number; readonly event_id: string }>`
              SELECT generation, event_id FROM flows_time_travel_archive
            `
            }
          })
        )

        expect(columns.map((column) => column.name)).toContain("generation")
        expect(rows).toEqual([{ generation: 0, event_id: "legacy-1" }])
        expect(generations).toEqual([{ run_id: "legacy", generation: 1 }])
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("applies the full ladder repeatedly across persistent database lifetimes", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-migrations-")))
      const filename = join(directory, "migrations.sqlite")
      try {
        yield* withDatabase(filename, Migrations.run.pipe(Effect.andThen(Migrations.run)))
        const rows = yield* withDatabase(
          filename,
          Migrations.run.pipe(
            Effect.andThen(Effect.service(SqlClient.SqlClient)),
            Effect.flatMap((sql) =>
              sql<{ readonly migration_id: number }>`
              SELECT migration_id FROM flows_migrations
              WHERE migration_id >= 5000 ORDER BY migration_id
            `
            )
          )
        )

        expect(rows).toEqual([5001, 5002, 5003, 5004, 5005, 5006, 5007].map((migration_id) => ({ migration_id })))
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("surfaces a non-duplicate ALTER TABLE failure", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-alter-")))
      const filename = join(directory, "alter.sqlite")
      try {
        const exit = yield* withDatabase(
          filename,
          Effect.gen(function*() {
            yield* EngineMigrations.run
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`CREATE VIEW flows_time_travel_snapshots AS SELECT 1 AS run_id`
            return yield* Effect.exit(SqlTimeTravelStore.migrate)
          })
        )

        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
