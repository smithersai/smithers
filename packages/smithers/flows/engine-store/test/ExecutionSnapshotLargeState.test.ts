import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.vibe"
import * as Read from "../src/internal/ExecutionSnapshotRead.vibe"
import * as Migrations from "../src/Migrations.vibe"
import * as RunCatalogRead from "../src/RunCatalogRead.ts"

describe("bounded execution observation SQL", () => {
  it.effect("discovers waiting requests when the catalog is constructed before migrations", () =>
    Effect.gen(function*() {
      const catalog = yield* RunCatalogRead.make()
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason, waiting_request)
        VALUES ('fresh', 'pending', 1, '{"version":1,"flowName":"fresh","payload":{}}', 'human', '{"prompt":"Continue?"}')`
      expect((yield* catalog.listRuns()).runs[0]?.waiting?.request).toEqual({ prompt: "Continue?" })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("observes an optional waiting request column added after a legacy page read", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      yield* sql`ALTER TABLE flows_runs DROP COLUMN waiting_request`
      const catalog = yield* RunCatalogRead.make()
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason)
        VALUES ('upgraded', 'pending', 1, '{"version":1,"flowName":"upgraded","payload":{}}', 'human')`
      expect((yield* catalog.listRuns()).runs[0]?.waiting).not.toHaveProperty("request")
      yield* sql`ALTER TABLE flows_runs ADD COLUMN waiting_request TEXT`
      yield* sql`UPDATE flows_runs SET waiting_request = '{"prompt":"Continue?"}' WHERE run_id = 'upgraded'`
      expect((yield* catalog.listRuns()).runs[0]?.waiting?.request).toEqual({ prompt: "Continue?" })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("projects lifecycle fields without transporting a 34 MiB native payload and result", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      const large = JSON.stringify({
        version: 1,
        flowName: "large",
        payload: "p".repeat(17 * 1024 * 1024),
        result: "r".repeat(17 * 1024 * 1024)
      })
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('large', 'pending', 1, ${large})`
      const rows = yield* Dialect.query(
        sql,
        `SELECT ${
          Read.selectColumns(sql)
        } FROM flows_runs r LEFT JOIN flows_run_changes c ON c.run_id = r.run_id WHERE r.run_id = ?`,
        ["large"]
      )
      expect(rows[0]).not.toHaveProperty("state_json")
      expect(JSON.stringify(rows).length).toBeLessThan(4096)
      const reader = yield* ExecutionSnapshot.make()
      expect((yield* reader.read(["large"])).snapshots[0]).toMatchObject({
        _tag: "Observed",
        flowName: "large",
        status: "pending"
      })
      const catalog = yield* RunCatalogRead.make()
      expect((yield* catalog.listRuns()).runs[0]).toMatchObject({ runId: "large", flowName: "large" })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("retains read compatibility when the optional waiting request column is absent", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('old', 'pending', 1, '{"version":1,"flowName":"old","payload":{}}')`
      const rows = yield* Dialect.query(
        sql,
        `SELECT ${
          Read.selectColumns(sql, false)
        } FROM flows_runs r LEFT JOIN flows_run_changes c ON c.run_id = r.run_id WHERE r.run_id = ?`,
        ["old"]
      )
      expect(rows[0]).toHaveProperty("waiting_request", null)
      expect(yield* Read.observed(rows[0], yield* Read.position(sql))).toMatchObject({
        _tag: "Observed",
        flowName: "old"
      })
    }).pipe(Effect.provide(TestDatabase.layer)))
  it.effect("preserves numeric JSON version spellings while rejecting strings", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      const reader = yield* ExecutionSnapshot.make()
      for (const [id, version] of [["decimal", "1.0"], ["string", "\"1\""]] as const) {
        const state = `{\"version\":${version},\"flowName\":\"versions\",\"payload\":{}}`
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${id}, 'pending', 1, ${state})`
      }
      expect((yield* reader.read(["decimal"])).snapshots[0]).toMatchObject({ _tag: "Observed", flowName: "versions" })
      expect((yield* Effect.flip(reader.read(["string"]))).code).toBe("decode_failed")
    }).pipe(Effect.provide(TestDatabase.layer)))
})
