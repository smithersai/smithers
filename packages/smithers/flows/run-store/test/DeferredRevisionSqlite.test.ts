import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.vibe"

it.effect("the deferred revision migration preserves SQLite triggers and revisions before commit", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const triggers = sql<{ name: string; sql: string }>`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'flows_runs_revision_%' ORDER BY name
    `
    const before = yield* triggers
    expect(before.map((row) => row.name)).toEqual([
      "flows_runs_revision_delete",
      "flows_runs_revision_insert",
      "flows_runs_revision_update"
    ])

    // SQLite must keep its immediate triggers, even if the PostgreSQL migration is explicitly applied again.
    yield* Migrations.deferredRevisions
    yield* Migrations.deferredRevisions
    expect(yield* triggers).toEqual(before)

    const head = sql<{ revision: number }>`SELECT revision FROM flows_run_source`
    const initial = (yield* head)[0]!.revision
    const change = sql<{ revision: number; deleted: number }>`
      SELECT revision, deleted FROM flows_run_changes WHERE run_id = 'sqlite-migration'
    `
    yield* sql.withTransaction(Effect.gen(function*() {
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('sqlite-migration', 'pending', 1, '{}')`
      expect(yield* head).toEqual([{ revision: initial + 1 }])
      expect(yield* change).toEqual([{ revision: initial + 1, deleted: 0 }])

      yield* sql`UPDATE flows_runs SET state_json = '{"updated":true}' WHERE run_id = 'sqlite-migration'`
      expect(yield* head).toEqual([{ revision: initial + 2 }])
      expect(yield* change).toEqual([{ revision: initial + 2, deleted: 0 }])

      yield* sql`DELETE FROM flows_runs WHERE run_id = 'sqlite-migration'`
      expect(yield* head).toEqual([{ revision: initial + 3 }])
      expect(yield* change).toEqual([{ revision: initial + 3, deleted: 1 }])
    }))
    expect(yield* head).toEqual([{ revision: initial + 3 }])
    expect(yield* change).toEqual([{ revision: initial + 3, deleted: 1 }])
  }).pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.sqliteLayer)))
