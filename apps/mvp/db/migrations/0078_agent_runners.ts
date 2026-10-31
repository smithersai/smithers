import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// External agents on runner machines (decision 0136, docs/features/agent-runners.md#postgres). Nothing here names an
// agent vendor: an agent is a name, the machine labels a runner must carry, and an opaque profile only the runner reads.
// Nothing is synced to browsers yet. A runner's token is never stored, only its SHA-256.
//
// - `runners`: the machines an Admin registered for a repository (`admin/AddRunner`), each with the labels it carries
//   and how many jobs it runs at once. A removed runner keeps its row, and its token is refused.
// - `agents`: the repository's named external agents (`admin/SetAgent`). At most one is the repository's coding agent,
//   which TODOs run on instead of their committers' model connections.
// - `agent_jobs`: one generation of a step an external agent does (`ExternalAgent`), keyed `<origin>#g<generation>`.
//   `task` is content (the prompt), read only by the runner that claims the job and never logged. A key cancelled before
//   its start arrived is a `cancelled` row with no task, so the start that arrives later queues nothing. A generation
//   after the first is pinned to the runner that ran the one before it, whose checkout holds the work so far.
// - `runner_changes`, `agent_changes`: each Admin change once, by the step's invocation key.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE runners (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_id text NOT NULL,
      name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
      labels text[] NOT NULL DEFAULT '{}',
      capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 64),
      token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      added_by text NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      seen_at timestamptz,
      removed_at timestamptz,
      UNIQUE (repo_id, name)
    )`
  yield* sql`
    CREATE TABLE runner_changes (
      invocation_key text PRIMARY KEY,
      repo_id text NOT NULL,
      name text NOT NULL,
      op text NOT NULL CHECK (op IN ('add', 'remove')),
      changed_by text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE agents (
      repo_id text NOT NULL,
      name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$' AND name <> 'smithers'),
      labels text[] NOT NULL DEFAULT '{}',
      profile text NOT NULL CHECK (profile ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
      max_hours integer NOT NULL DEFAULT 4 CHECK (max_hours BETWEEN 1 AND 12),
      restarts integer NOT NULL DEFAULT 1 CHECK (restarts BETWEEN 0 AND 5),
      coding boolean NOT NULL DEFAULT false,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repo_id, name)
    )`
  yield* sql`CREATE UNIQUE INDEX agents_one_coding ON agents (repo_id) WHERE coding`
  yield* sql`
    CREATE TABLE agent_changes (
      invocation_key text PRIMARY KEY,
      repo_id text NOT NULL,
      name text NOT NULL,
      op text NOT NULL CHECK (op IN ('set', 'remove')),
      changed_by text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE agent_jobs (
      key text PRIMARY KEY,
      origin text NOT NULL,
      generation integer NOT NULL CHECK (generation >= 1),
      repo_id text,
      agent text,
      profile text,
      labels text[],
      task jsonb,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled', 'retryable')),
      pinned_runner uuid REFERENCES runners (id),
      runner_id uuid REFERENCES runners (id),
      claim uuid,
      lease_until timestamptz,
      not_before timestamptz,
      deadline_at timestamptz,
      cancel_requested boolean NOT NULL DEFAULT false,
      outcome jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      settled_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((status = 'claimed') = (claim IS NOT NULL)),
      CHECK ((status = 'claimed') = (lease_until IS NOT NULL)),
      CHECK ((status IN ('done', 'failed', 'cancelled', 'retryable')) = (outcome IS NOT NULL)),
      CHECK (num_nulls(repo_id, agent, profile, labels, task, deadline_at) = 0 OR (
        num_nulls(repo_id, agent, profile, labels, task, deadline_at) = 6 AND status = 'cancelled'))
    )`
  // The claim: a repository's oldest queued job for the profiles a runner has.
  yield* sql`CREATE INDEX agent_jobs_queued ON agent_jobs (repo_id, profile, created_at) WHERE status = 'queued'`
  // A runner's running jobs, counted against its capacity and handed back after it restarts.
  yield* sql`CREATE INDEX agent_jobs_runner ON agent_jobs (runner_id) WHERE status = 'claimed'`
})
