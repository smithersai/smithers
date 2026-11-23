import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Deployment-wide fleet visibility (`/app/fleet`): every host node (MacBook Pro, Mac mini, Latitude bare metal,
// Cloudflare sandboxes, LAN), every managed and observed agent session (Claude, Codex, AGY CLI/IDE, cfbox,
// BranchSandbox), and every monitored provider account (Claude Max, Codex Pro, Google/AGY). Zero secrets, emails,
// tokens, or raw prompts are stored (OBS-5). Every table carries REPLICA IDENTITY FULL for ElectricSQL shapes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE host_nodes (
      node_id text PRIMARY KEY CHECK (char_length(node_id) BETWEEN 1 AND 128),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
      kind text NOT NULL CHECK (kind IN ('macbook', 'mac-mini', 'bare-metal', 'cloudflare', 'lan', 'browser')),
      labels text[] NOT NULL DEFAULT '{}',
      online boolean NOT NULL DEFAULT true,
      held text CHECK (char_length(held) <= 120),
      load1 double precision CHECK (load1 >= 0),
      cpu_cores integer CHECK (cpu_cores >= 0),
      mem_used_gb double precision CHECK (mem_used_gb >= 0),
      mem_total_gb double precision CHECK (mem_total_gb >= 0),
      disk_free_gb double precision CHECK (disk_free_gb >= 0),
      disk_total_gb double precision CHECK (disk_total_gb >= 0),
      active_sessions integer NOT NULL DEFAULT 0 CHECK (active_sessions >= 0),
      runner_capacity integer NOT NULL DEFAULT 0 CHECK (runner_capacity >= 0),
      version text CHECK (char_length(version) <= 64),
      seen_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`ALTER TABLE host_nodes REPLICA IDENTITY FULL`
  yield* sql`CREATE INDEX host_nodes_seen ON host_nodes (seen_at DESC)`

  yield* sql`
    CREATE TABLE observed_sessions (
      session_key text PRIMARY KEY CHECK (char_length(session_key) BETWEEN 1 AND 256),
      node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 128),
      managed boolean NOT NULL DEFAULT false,
      harness text NOT NULL CHECK (harness IN ('claude', 'codex', 'agy-cli', 'agy-ide', 'cfbox', 'cf-sandbox', 'smithers', 'daemon')),
      model text CHECK (char_length(model) <= 120),
      account_label text CHECK (char_length(account_label) <= 64),
      repo text CHECK (char_length(repo) <= 160),
      lane text CHECK (char_length(lane) <= 120),
      title text CHECK (char_length(title) <= 160),
      status text NOT NULL DEFAULT 'working' CHECK (status IN ('working', 'idle', 'stalled', 'waiting', 'error', 'ended')),
      pid integer CHECK (pid >= 0),
      cpu_seconds double precision CHECK (cpu_seconds >= 0),
      tokens_used bigint CHECK (tokens_used >= 0),
      started_at timestamptz,
      last_activity_at timestamptz,
      ended_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`ALTER TABLE observed_sessions REPLICA IDENTITY FULL`
  yield* sql`CREATE INDEX observed_sessions_node ON observed_sessions (node_id, status, updated_at DESC)`

  yield* sql`
    CREATE TABLE provider_accounts (
      account_key text PRIMARY KEY CHECK (char_length(account_key) BETWEEN 1 AND 128),
      provider text NOT NULL CHECK (provider IN ('claude', 'codex', 'google-agy')),
      label text NOT NULL CHECK (char_length(label) <= 64),
      plan text CHECK (char_length(plan) <= 64),
      status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('ready', 'cooling', 'limit_reached', 'auth_expired', 'unknown')),
      five_hour_pct double precision CHECK (five_hour_pct >= 0 AND five_hour_pct <= 200),
      weekly_pct double precision CHECK (weekly_pct >= 0 AND weekly_pct <= 200),
      scoped_pct double precision CHECK (scoped_pct >= 0 AND scoped_pct <= 200),
      resets_at timestamptz,
      grants_json jsonb,
      credits_balance double precision CHECK (credits_balance >= 0),
      active_sessions integer NOT NULL DEFAULT 0 CHECK (active_sessions >= 0),
      pools text[] NOT NULL DEFAULT '{}',
      cool_reason text CHECK (char_length(cool_reason) <= 120),
      cool_until timestamptz,
      source_node text CHECK (char_length(source_node) <= 128),
      checked_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`ALTER TABLE provider_accounts REPLICA IDENTITY FULL`
  yield* sql`CREATE INDEX provider_accounts_provider ON provider_accounts (provider, label)`
})
