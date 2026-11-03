import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Cloned repositories and what Code Storage costs (docs/features/repo.md#postgres, decision 0006). `repositories` is
// synced to every device through Electric; the other two tables never leave the server.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // One row per cloned repository: its clone's status, and its default branch's head commit once ready.
  yield* sql`
    CREATE TABLE repositories (
      id text PRIMARY KEY,
      owner text NOT NULL,
      name text NOT NULL,
      status text NOT NULL CHECK (status IN ('cloning', 'ready', 'failed', 'capacity')),
      failure text CHECK (failure IN ('not_found', 'empty', 'unavailable', 'timed_out')),
      capacity text CHECK (capacity IN ('paused', 'storage', 'reads', 'too_large', 'size_unknown')),
      stored_bytes bigint CHECK (stored_bytes >= 0),
      retry_at timestamptz,
      default_branch text,
      head_sha text,
      head_message text,
      head_author text,
      head_at timestamptz,
      attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
      requested_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      CHECK ((status = 'failed') = (failure IS NOT NULL)),
      CHECK ((status = 'capacity') = (capacity IS NOT NULL)),
      CHECK (status <> 'ready' OR head_sha IS NOT NULL)
    )`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE repositories REPLICA IDENTITY FULL`
  // The operator's switch: while `paused`, admission refuses every new import. One row.
  yield* sql`
    CREATE TABLE repo_imports (
      id integer PRIMARY KEY CHECK (id = 1),
      paused boolean NOT NULL DEFAULT false,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`INSERT INTO repo_imports (id) VALUES (1)`
  // What Code Storage was asked for each UTC month, and the highest spend alert already raised for it.
  yield* sql`
    CREATE TABLE code_storage_usage (
      month date PRIMARY KEY,
      bytes_read bigint NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
      bytes_imported bigint NOT NULL DEFAULT 0 CHECK (bytes_imported >= 0),
      alerted_pct integer NOT NULL DEFAULT 0
    )`
})
