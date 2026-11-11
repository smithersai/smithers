import { expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

it.effect("upgrades published lineage indexes without changing copied journal evidence", () =>
  Effect.gen(function*() {
    yield* EngineMigrations.run
    yield* DatabaseMigrations.run([{
      ...Migrations.set,
      migrations: Object.fromEntries(Object.entries(Migrations.set.migrations).filter(([key]) => key < "0007"))
    }])
    const sql = yield* SqlClient.SqlClient
    const payload = JSON.stringify({
      effect: {
        kind: "flows/engine-store/child-spawn",
        runId: "parent",
        status: "succeeded",
        output: { childRunId: "child" }
      }
    })
    for (const runId of ["parent", "fork"]) {
      yield* sql`INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES (${runId}, 1, ${runId}, 'engine', 0, 0, 'flows.time-travel.effect-boundary', ${payload}, '{}')`
    }
    const before = yield* sql`SELECT run_id, event_id, payload_json FROM flows_journal_events ORDER BY run_id`
    const store = yield* SqlTimeTravelStore.make
    expect((yield* store.descendants("parent", { lineageId: "parent", seq: 0 })).detached).toHaveLength(1)
    expect(yield* store.descendants("fork", { lineageId: "parent", seq: 0 })).toEqual({ attached: [], detached: [] })
    expect(yield* sql`SELECT run_id, event_id, payload_json FROM flows_journal_events ORDER BY run_id`).toEqual(before)
    const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`SELECT name, sql FROM ${
      TestDatabase.catalog(sql)
    } WHERE name IN ('flows_journal_events_child_spawn_idx', 'flows_journal_events_handoff_idx') ORDER BY name`
    expect(indexes).toHaveLength(2)
    expect(indexes[0]!.sql).toContain("effect")
    expect(indexes[0]!.sql).toContain("runId")
    expect(indexes[1]!.sql).toContain("fork:")
    yield* Migrations.run
    expect(yield* sql`SELECT run_id, event_id, payload_json FROM flows_journal_events ORDER BY run_id`).toEqual(before)
  }).pipe(Effect.provide(TestDatabase.layer)))
