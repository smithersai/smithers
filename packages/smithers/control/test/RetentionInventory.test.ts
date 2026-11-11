/**
 * `Retention.collect` over a database every store a host composes migrates
 * into: the engine ladder, the plan store, time travel, and this package.
 *
 * The inventory lives in `@smthrs/engine-store`, which cannot see this
 * package's tables, so the guard that pins it against the catalog runs here.
 * A table that names a run and is in none of the sets below is a table
 * retention leaks forever: a collected run's signals, approval tokens, grants
 * and resume requests stayed with their payloads and principals, and its
 * journal generation row made every later step-cache rebuild clear the cache.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Retention from "@smthrs/engine-store/Retention"
import * as PlanMigrations from "@smthrs/plan-store/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

const hosted = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function*() {
    yield* EngineMigrations.run
    yield* PlanMigrations.run
    yield* TimeTravelMigrations.run
    yield* Migrations.run
    return yield* effect
  }).pipe(Effect.provide(TestDatabase.layer))

const seedRun = (runId: string, finishedAtMs: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_runs ${
      sql.insert({
        run_id: runId,
        status: "completed",
        created_at_ms: 1,
        started_at_ms: 1,
        finished_at_ms: finishedAtMs,
        owner_host_id: null,
        owner_pid: null,
        owner_nonce: null,
        heartbeat_at_ms: null,
        parent_run_id: null,
        state_json: "{}"
      })
    }`
    yield* sql`INSERT INTO control_runs ${sql.insert({ run_id: runId, created_seq: 0 })}`
    yield* sql`INSERT INTO control_signal_commands ${
      sql.insert({
        command_id: `signal-${runId}`,
        run_id: runId,
        payload_json: "{}",
        principal_json: "{}",
        state: "delivered"
      })
    }`
    for (const table of ["control_tokens", "control_grants"]) {
      const columns = table === "control_tokens"
        ? { target_json: "{}", resolved: 1 }
        : { envelope_json: "{}", scope: "once", installed_at_ms: 0 }
      yield* sql`INSERT INTO ${sql.unsafe(table)} ${
        sql.insert({
          target_tag: "Node",
          run_id: runId,
          target_id: `node-${runId}`,
          token_id: `node-${runId}`,
          ...columns
        })
      }`
    }
    yield* sql`INSERT INTO control_run_resumes ${sql.insert({ run_id: runId, requested_seq: 0, requested_at_ms: 0 })}`
    yield* sql`INSERT INTO flows_journal_generations ${sql.insert({ run_id: runId, generation: 1, after_seq: -1 })}`
  })

const runKeyed = [
  "control_runs",
  "control_signal_commands",
  "control_tokens",
  "control_grants",
  "control_run_resumes",
  "flows_journal_generations"
] as const

const runIdsIn = (table: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly run_id: string }>`
      SELECT run_id FROM ${sql.unsafe(table)} ORDER BY run_id
    `
    return rows.map((row) => row.run_id)
  })

describe("Retention over a hosted database", () => {
  it.effect("collects a run's control-plane and journal-generation rows with it", () =>
    hosted(Effect.gen(function*() {
      yield* seedRun("old", 100)
      yield* seedRun("recent", 900)
      const sql = yield* SqlClient.SqlClient
      // A plan-level approval names no run and must outlive every pass.
      yield* sql`INSERT INTO control_tokens ${
        sql.insert({
          target_tag: "Plan",
          run_id: "",
          target_id: "plan",
          token_id: "plan",
          target_json: "{}",
          resolved: 0
        })
      }`

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual(["old"])
      for (const table of runKeyed) {
        expect(report.deleted[table]).toBe(1)
        expect(yield* runIdsIn(table)).toEqual(table === "control_tokens" ? ["", "recent"] : ["recent"])
      }
    })))

  it.effect("accounts for every run-naming table a host composes", () =>
    hosted(Effect.gen(function*() {
      // Listing is deliberate, so this pins the list against the catalog of a
      // database holding every store's tables rather than trusting it.
      const sql = yield* SqlClient.SqlClient
      const rows: Array<string> = []
      for (const table of yield* Dialect.tables(sql)) {
        for (const column of yield* Dialect.columns(sql, table.name)) {
          if (column.name.endsWith("run_id") || ["execution_id", "child_id", "parent_id"].includes(column.name)) {
            rows.push(`${table.name}.${column.name}`)
          }
        }
      }
      const cascades = new Set((yield* sql.onDialectOrElse({
        pg: () =>
          sql<{ table_name: string }>`SELECT rel.relname AS table_name
          FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
          WHERE con.confrelid = 'flows_runs'::regclass AND con.confdeltype = 'c'`,
        orElse: () =>
          sql<{ table_name: string }>`SELECT m.name AS table_name
          FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
          WHERE m.type = 'table' AND f."table" = 'flows_runs' AND f.on_delete = 'CASCADE'`
      })).map((row) => row.table_name))
      const inventory = new Set(Retention.runScopedTables.map((entry) => `${entry.table}.${entry.column}`))
      const exempt = new Set([
        // The run row itself, deleted last in generation order.
        "flows_runs.run_id",
        "flows_runs.parent_run_id",
        // Dropped with each run row by the `flows_run_parents_gc` trigger.
        "flows_run_parents.child_id",
        "flows_run_parents.parent_id",
        // Deletion tombstones the change feed reads after the row is gone.
        "flows_run_changes.run_id",
        // The shared step cache outlives the run that first recorded an entry.
        "flows_step_cache.recorded_run_id",
        // A fork edge belongs to its child and goes with `child_run_id`; a
        // surviving fork keeps the edge naming the parent it was forked from.
        "flows_time_travel_edges.parent_run_id",
        // A fork intent names a run that does not exist yet and is consumed
        // when the fork commits; a leftover keeps its ordinal taken on purpose.
        "flows_time_travel_fork_intents.child_run_id",
        "flows_time_travel_fork_intents.parent_run_id"
      ])
      expect(rows.filter((key) => !inventory.has(key) && !exempt.has(key) && !cascades.has(key.split(".")[0]!)))
        .toEqual([])
      // Every inventoried table exists here, so the walk above saw all of them.
      const present = new Set((yield* Dialect.tables(sql)).map((table) => table.name))
      expect(Retention.runScopedTables.filter((entry) => !present.has(entry.table))).toEqual([])
    })))
})
