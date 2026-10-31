import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The fleet: every agent run and runner machine a repository has, and the alerts about them (decision 0143,
// docs/features/fleet.md).
//
// - `agent_runs`: one row per generation of an external agent's job, keyed as `agent_jobs` is (`<origin>#g<n>`). It is
//   the job's projection for people, written only under the job's own key: by the job store when the step starts it,
//   cancels it and probes it (at most once a probe, only when something changed), and by the runner routes when a
//   runner claims and settles it (worker/runners/Fleet.ts). Nothing sweeps it. It holds no task, prompt, summary or
//   file. `activity_at` is the last sign of work: the claim, the agent's last transcript event, or the last time the
//   agent's process tree used 5 more CPU seconds (`cpu_mark`); a working job whose activity is older than the stall
//   threshold reads `stalled`. `alerted` lists the alerts the probe started for it, so it starts each once.
// - `agent_jobs` gains what each heartbeat says: the account label the runner's hook chose, the agent's process-tree
//   CPU seconds, and the usage it reported so far. The job store, not the heartbeat, projects them.
// - `runners` gains what each claim says about its machine: version, load and free disk.
// - `fleet_alerts`: one row per incident (a run that failed, stalled, waited too long or cost too much; a runner that
//   went offline), keyed by its alert id, which is also its `ops/FleetAlert` execution and its delivery receipts' key.
//   `closed_at` is when it recovered.
// - `notifications` takes kind `fleet`: an alert in a person's bell.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE agent_jobs
      ADD COLUMN account_label text CHECK (account_label ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
      ADD COLUMN cpu_seconds double precision CHECK (cpu_seconds >= 0),
      ADD COLUMN usage jsonb`
  yield* sql`
    ALTER TABLE runners
      ADD COLUMN version text CHECK (char_length(version) BETWEEN 1 AND 64),
      ADD COLUMN load1 double precision CHECK (load1 >= 0),
      ADD COLUMN disk_free_gb double precision CHECK (disk_free_gb >= 0)`
  // Electric sends whole rows on update and delete: the machines shape syncs runners.
  yield* sql`ALTER TABLE runners REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE agent_runs (
      key text PRIMARY KEY,
      repo_id text NOT NULL,
      agent text NOT NULL,
      generation integer NOT NULL CHECK (generation >= 1),
      run_id text CHECK (char_length(run_id) <= 200),
      todo_id uuid,
      number integer CHECK (number >= 1),
      title text CHECK (char_length(title) <= 120),
      runner text,
      account_label text,
      state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'working', 'stalled', 'stopping', 'stopped', 'failed', 'done', 'retried')),
      reason text CHECK (char_length(reason) <= 40),
      queued_at timestamptz NOT NULL,
      claimed_at timestamptz,
      first_event_at timestamptz,
      last_event_at timestamptz,
      activity_at timestamptz,
      ended_at timestamptz,
      context_tokens bigint CHECK (context_tokens >= 0),
      cost_usd numeric(12, 4) CHECK (cost_usd >= 0),
      transcript_bytes bigint CHECK (transcript_bytes >= 0),
      cpu_seconds double precision CHECK (cpu_seconds >= 0),
      cpu_mark double precision CHECK (cpu_mark >= 0),
      alerted text[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`ALTER TABLE agent_runs REPLICA IDENTITY FULL`
  // A repository's runs, newest first: its shape and its counts.
  yield* sql`CREATE INDEX agent_runs_repo ON agent_runs (repo_id, queued_at DESC)`
  yield* sql`
    CREATE TABLE fleet_alerts (
      id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 300),
      kind text NOT NULL CHECK (kind IN ('failed', 'stalled', 'offline', 'waiting', 'cost')),
      repo_id text NOT NULL,
      subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      href text NOT NULL CHECK (href ~ '^/' AND char_length(href) <= 600),
      recipients integer NOT NULL DEFAULT 0 CHECK (recipients >= 0),
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz
    )`
  // An incident still open, by what it is about: what recovery closes.
  yield* sql`CREATE INDEX fleet_alerts_open ON fleet_alerts (kind, subject) WHERE closed_at IS NULL`
  yield* sql`ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check`
  yield* sql`
    ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
      CHECK (kind IN ('run', 'main', 'release', 'clone', 'spend', 'bug', 'write', 'fleet'))`
})
