import { Database } from "bun:sqlite"

import { DATABASE_PATH } from "@/config/paths"

export const db = new Database(DATABASE_PATH, { create: true })

// Allow concurrent readers/writers across daemon + tests and reduce flaky SQLITE_BUSY failures.
db.exec("PRAGMA journal_mode = WAL;")
db.exec("PRAGMA busy_timeout = 5000;")

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    branch TEXT,
    repo_url TEXT,
    default_agent TEXT,
    health_status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const workspaceColumns = db
  .query<{ name: string }, []>(`PRAGMA table_info(workspaces)`)
  .all()
const workspaceColumnNames = new Set(workspaceColumns.map((column) => column.name))

if (!workspaceColumnNames.has("runtime_mode")) {
  db.exec(`ALTER TABLE workspaces ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'burns-managed';`)
}

if (!workspaceColumnNames.has("smithers_base_url")) {
  db.exec(`ALTER TABLE workspaces ADD COLUMN smithers_base_url TEXT;`)
}

db.exec(`
  CREATE TABLE IF NOT EXISTS run_events (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    node_id TEXT,
    message TEXT,
    raw_payload_json TEXT,
    dedupe_key TEXT,
    PRIMARY KEY (workspace_id, run_id, seq)
  );
`)

const runEventColumns = db
  .query<{ name: string }, []>(`PRAGMA table_info(run_events)`)
  .all()
const runEventColumnNames = new Set(runEventColumns.map((column) => column.name))

if (!runEventColumnNames.has("raw_payload_json")) {
  db.exec(`ALTER TABLE run_events ADD COLUMN raw_payload_json TEXT;`)
}

if (!runEventColumnNames.has("dedupe_key")) {
  db.exec(`ALTER TABLE run_events ADD COLUMN dedupe_key TEXT;`)
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS run_events_dedupe_key_idx
    ON run_events(workspace_id, run_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    wait_minutes INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, run_id, node_id)
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_root TEXT NOT NULL,
    default_agent TEXT NOT NULL,
    smithers_base_url TEXT NOT NULL,
    allow_network INTEGER NOT NULL DEFAULT 0,
    max_concurrency INTEGER NOT NULL DEFAULT 4,
    max_body_bytes INTEGER NOT NULL DEFAULT 1048576,
    smithers_managed_per_workspace INTEGER NOT NULL DEFAULT 0,
    smithers_auth_mode TEXT,
    smithers_auth_token TEXT,
    root_dir_policy TEXT NOT NULL DEFAULT 'workspace-root',
    diagnostics_log_level TEXT NOT NULL DEFAULT 'info',
    diagnostics_pretty_logs INTEGER NOT NULL DEFAULT 0,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`)

const appSettingsColumns = db
  .query<{ name: string }, []>(`PRAGMA table_info(app_settings)`)
  .all()
const appSettingsColumnNames = new Set(appSettingsColumns.map((column) => column.name))

if (!appSettingsColumnNames.has("max_concurrency")) {
  db.exec(`ALTER TABLE app_settings ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 4;`)
}

if (!appSettingsColumnNames.has("max_body_bytes")) {
  db.exec(`ALTER TABLE app_settings ADD COLUMN max_body_bytes INTEGER NOT NULL DEFAULT 1048576;`)
}
