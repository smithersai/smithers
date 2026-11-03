import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Custom domains (decision 0039, docs/features/domains.md).
//
// - `domains`: one row per hostname, so a hostname belongs to at most one repository. `provider_id` is the provider's
//   own id for it (a Cloudflare custom hostname's), `null` until the first check registers it. `poll_id` is the
//   `domain/Verify` lineage that owns the row: an older poll that finds another id stops. `records` are the DNS records
//   the maintainer adds, `[{ type, name, value }]`. Only the `domain/*` flows write it. The browser's shape reads
//   everything but `provider_id`, `poll_id` and `updated_by`, and only for a Maintainer or Admin.
// - `domain_events`: the audit. A person's add, refresh and remove, once per flow step (`invocation_key`), and the
//   provider's verdicts as the poll sees them change.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE domains (
      hostname text PRIMARY KEY CHECK (hostname = lower(hostname) AND length(hostname) BETWEEN 3 AND 253),
      repo_id text NOT NULL,
      provider_id text,
      poll_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('pending', 'active', 'failed', 'removing')),
      verification text NOT NULL CHECK (verification IN ('pending', 'active', 'failed')),
      certificate text NOT NULL CHECK (certificate IN ('pending', 'active', 'failed', 'unmanaged')),
      records jsonb NOT NULL DEFAULT '[]'::jsonb,
      problem text,
      checked_at timestamptz,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX domains_repo ON domains (repo_id)`
  yield* sql`ALTER TABLE domains REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE domain_events (
      id bigserial PRIMARY KEY,
      hostname text NOT NULL,
      repo_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('add', 'refresh', 'remove', 'check')),
      actor_id text,
      invocation_key text UNIQUE,
      state text,
      problem text,
      at timestamptz NOT NULL DEFAULT now(),
      CHECK ((action = 'check') OR (actor_id IS NOT NULL AND invocation_key IS NOT NULL))
    )`
  yield* sql`CREATE INDEX domain_events_repo_at ON domain_events (repo_id, at DESC)`
})
