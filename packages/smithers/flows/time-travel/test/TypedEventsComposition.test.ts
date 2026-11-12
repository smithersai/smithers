import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as RunMigrations from "@smthrs/run-store/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

describe("history authority in a minimal composition", () => {
  it.effect("forks real SQLite history without requiring the engine spawn-edge extension", () =>
    Effect.gen(function*() {
      yield* DatabaseMigrations.run([JournalMigrations.set, RunMigrations.set])
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      expect(yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'flows_run_parents'`).toEqual([])
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})`
      const fork = yield* store.createFork("parent", { lineageId: "parent/root", seq: 0 })
      expect(fork.runId).toBe("parent:fork:0:1")
      expect(
        yield* sql`SELECT run_id, status, parent_run_id, lineage_id, round_ordinal
        FROM flows_runs WHERE run_id = 'parent:fork:0:1'`
      ).toEqual([{
        run_id: "parent:fork:0:1",
        status: "pending",
        parent_run_id: "parent",
        lineage_id: "parent:fork:0:1",
        round_ordinal: 0
      }])
    }).pipe(Effect.provide(TestDatabase.layer)))

  const record = (runId: string, seq: number, lineageId: string) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (${runId}, ${seq}, ${`${runId}-${seq}`}, 'source', ${seq}, ${seq}, 'test', '{}',
                  ${JSON.stringify({ lineageId })})`
    )

  it.effect("truncates real SQLite history without the engine's wait projections", () =>
    Effect.gen(function*() {
      yield* DatabaseMigrations.run([JournalMigrations.set, RunMigrations.set])
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      expect(yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'flows_deferred_completions'`)
        .toEqual([])
      yield* sql`INSERT INTO flows_runs
        (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
        VALUES ('run', 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
                'host', 7, 'nonce', 0)`
      for (const seq of [0, 1, 2]) yield* record("run", seq, "run/root")
      // A settled child spawned after the frame is archived whole with it.
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('kid', 'completed', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})`
      yield* record("kid", 0, "kid")
      yield* sql`INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
        VALUES ('run', 1, 'kid', 'child', 1)`
      const owner = { hostId: "host", pid: 7, nonce: "nonce" }
      expect(yield* store.archiveAndTruncate("run", { lineageId: "run/root", seq: 0 }, [], owner))
        .toMatchObject({ archived: 3 })
      expect(yield* sql`SELECT run_id, seq FROM flows_journal_events ORDER BY run_id`).toEqual([{
        run_id: "run",
        seq: 0
      }])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("carries a spawned child without the engine spawn-edge table", () =>
    Effect.gen(function*() {
      yield* DatabaseMigrations.run([JournalMigrations.set, RunMigrations.set])
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      for (const [runId, status] of [["p", "suspended"], ["c", "completed"]] as const) {
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES (${runId}, ${status}, 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})`
        yield* record(runId, 0, runId)
      }
      yield* sql`INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
        VALUES ('p', 0, 'c', 'child', 0)`
      yield* store.createFork("p", { lineageId: "p", seq: 0 }, "f", undefined, { children: [{ from: "c", to: "c2" }] })
      expect(yield* sql`SELECT parent_run_id FROM flows_runs WHERE run_id = 'c2'`).toEqual([{ parent_run_id: "f" }])
      expect(yield* sql`SELECT event_id FROM flows_journal_events WHERE run_id = 'c2' AND seq = 0`).toEqual([{
        event_id: "fork:c2:c-0"
      }])
    }).pipe(Effect.provide(TestDatabase.layer)))
})
