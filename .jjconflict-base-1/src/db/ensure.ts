import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { fromSync } from "../effect/interop";
import { runSync } from "../effect/runtime";
import { SmithersError } from "../utils/errors";

export function ensureSmithersTablesEffect(
  db: BunSQLiteDatabase<any>,
): Effect.Effect<void, SmithersError> {
  const client: any = (db as any).$client;
  if (!client || typeof client.exec !== "function") {
    throw new SmithersError(
      "DB_REQUIRES_BUN_SQLITE",
      "Smithers requires a Bun SQLite database client with exec().",
    );
  }

  return Effect.gen(function* () {
    yield* fromSync(
      "ensure smithers tables",
      () =>
        client.exec(`
        CREATE TABLE IF NOT EXISTS _smithers_runs (
          run_id TEXT PRIMARY KEY,
          workflow_name TEXT NOT NULL,
          workflow_path TEXT,
          workflow_hash TEXT,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          heartbeat_at_ms INTEGER,
          runtime_owner_id TEXT,
          cancel_requested_at_ms INTEGER,
          hijack_requested_at_ms INTEGER,
          hijack_target TEXT,
          vcs_type TEXT,
          vcs_root TEXT,
          vcs_revision TEXT,
          error_json TEXT,
          config_json TEXT
        );

        CREATE TABLE IF NOT EXISTS _smithers_nodes (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL,
          last_attempt INTEGER,
          updated_at_ms INTEGER NOT NULL,
          output_table TEXT NOT NULL,
          label TEXT,
          PRIMARY KEY (run_id, node_id, iteration)
        );

        CREATE TABLE IF NOT EXISTS _smithers_attempts (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL,
          state TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER,
          error_json TEXT,
          jj_pointer TEXT,
          response_text TEXT,
          jj_cwd TEXT,
          cached INTEGER DEFAULT 0,
          meta_json TEXT,
          PRIMARY KEY (run_id, node_id, iteration, attempt)
        );

        CREATE TABLE IF NOT EXISTS _smithers_frames (
          run_id TEXT NOT NULL,
          frame_no INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          xml_json TEXT NOT NULL,
          xml_hash TEXT NOT NULL,
          mounted_task_ids_json TEXT,
          task_index_json TEXT,
          note TEXT,
          PRIMARY KEY (run_id, frame_no)
        );

        CREATE TABLE IF NOT EXISTS _smithers_approvals (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          requested_at_ms INTEGER,
          decided_at_ms INTEGER,
          note TEXT,
          decided_by TEXT,
          PRIMARY KEY (run_id, node_id, iteration)
        );

        CREATE TABLE IF NOT EXISTS _smithers_cache (
          cache_key TEXT PRIMARY KEY,
          created_at_ms INTEGER NOT NULL,
          workflow_name TEXT NOT NULL,
          node_id TEXT NOT NULL,
          output_table TEXT NOT NULL,
          schema_sig TEXT NOT NULL,
          agent_sig TEXT,
          tools_sig TEXT,
          jj_pointer TEXT,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _smithers_tool_calls (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          input_json TEXT,
          output_json TEXT,
          started_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER,
          status TEXT NOT NULL,
          error_json TEXT,
          PRIMARY KEY (run_id, node_id, iteration, attempt, seq)
        );

        CREATE TABLE IF NOT EXISTS _smithers_events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (run_id, seq)
        );

        CREATE TABLE IF NOT EXISTS _smithers_ralph (
          run_id TEXT NOT NULL,
          ralph_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          done INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, ralph_id)
        );

        CREATE TABLE IF NOT EXISTS _smithers_cron (
          cron_id TEXT PRIMARY KEY,
          pattern TEXT NOT NULL,
          workflow_path TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          created_at_ms INTEGER NOT NULL,
          last_run_at_ms INTEGER,
          next_run_at_ms INTEGER,
          error_json TEXT
        );

        CREATE TABLE IF NOT EXISTS _smithers_snapshots (
          run_id TEXT NOT NULL,
          frame_no INTEGER NOT NULL,
          nodes_json TEXT NOT NULL,
          outputs_json TEXT NOT NULL,
          ralph_json TEXT NOT NULL,
          input_json TEXT NOT NULL,
          vcs_pointer TEXT,
          workflow_hash TEXT,
          content_hash TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, frame_no)
        );

        CREATE TABLE IF NOT EXISTS _smithers_branches (
          run_id TEXT PRIMARY KEY,
          parent_run_id TEXT NOT NULL,
          parent_frame_no INTEGER NOT NULL,
          branch_label TEXT,
          fork_description TEXT,
          created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _smithers_vcs_tags (
          run_id TEXT NOT NULL,
          frame_no INTEGER NOT NULL,
          vcs_type TEXT NOT NULL,
          vcs_pointer TEXT NOT NULL,
          vcs_root TEXT,
          jj_operation_id TEXT,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, frame_no)
        );

        CREATE TABLE IF NOT EXISTS _smithers_vectors (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          metadata_json TEXT,
          document_id TEXT,
          chunk_index INTEGER,
          created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _smithers_scorers (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          scorer_id TEXT NOT NULL,
          scorer_name TEXT NOT NULL,
          source TEXT NOT NULL,
          score REAL NOT NULL,
          reason TEXT,
          meta_json TEXT,
          input_json TEXT,
          output_json TEXT,
          latency_ms REAL,
          scored_at_ms INTEGER NOT NULL,
          duration_ms REAL
        );

        CREATE TABLE IF NOT EXISTS _smithers_memory_facts (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          schema_sig TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          ttl_ms INTEGER,
          PRIMARY KEY (namespace, key)
        );

        CREATE TABLE IF NOT EXISTS _smithers_memory_threads (
          thread_id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          title TEXT,
          metadata_json TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _smithers_memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL,
          run_id TEXT,
          node_id TEXT,
          created_at_ms INTEGER NOT NULL
        );
      `),
      { code: "DB_WRITE_FAILED" },
    );

    // Migrations for columns added after initial schema
    const migrations = [
      `ALTER TABLE _smithers_attempts ADD COLUMN response_text TEXT`,
      `ALTER TABLE _smithers_attempts ADD COLUMN jj_cwd TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN workflow_hash TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN heartbeat_at_ms INTEGER`,
      `ALTER TABLE _smithers_runs ADD COLUMN runtime_owner_id TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN cancel_requested_at_ms INTEGER`,
      `ALTER TABLE _smithers_runs ADD COLUMN hijack_requested_at_ms INTEGER`,
      `ALTER TABLE _smithers_runs ADD COLUMN hijack_target TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN vcs_type TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN vcs_root TEXT`,
      `ALTER TABLE _smithers_runs ADD COLUMN vcs_revision TEXT`,
    ];
    for (const statement of migrations) {
      yield* Effect.either(
        fromSync("run smithers migration", () => client.run(statement), {
          code: "DB_WRITE_FAILED",
          details: { statement },
        }),
      );
    }
  }).pipe(Effect.withLogSpan("db:ensure-smithers-tables"));
}

export function ensureSmithersTables(db: BunSQLiteDatabase<any>): void {
  runSync(ensureSmithersTablesEffect(db));
}
