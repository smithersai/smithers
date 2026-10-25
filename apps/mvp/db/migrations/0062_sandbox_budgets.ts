import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Sandbox budgets (ruling AUTH-5, decision 0103, docs/features/sandbox-budgets.md): how many machines may be awake, for
// the deployment and for each person, and what a month of them may cost before the Admins hear of it.
//
// - `sandbox_limits`: the Admins' limits, one row (`audience` `admin`), changed in Settings without a deploy. No row
//   means the defaults: 20 awake machines, 2 per person, an alert at $100 a month. `monthly_alert_usd` 0 turns the
//   alert off.
// - `sandbox_generations`: the ledger of machines. A row is one machine's slot from its admission to its sleep: the
//   branch (one machine per branch, so at most one open row per branch), the person who woke it (none for CI), its
//   kind, its instance type and generation once it started, and `seen_at`, which `sandbox/Keep` renews every minute
//   while the machine is awake. An open row counts as awake while `seen_at` is recent; `ended_at` closes it. Spend is
//   each row's awake time priced by its instance type.
// - `terminal_sessions.waiting`: the terminal waits for a free machine ("Waiting for a sandbox"); `admitted_at` is when
//   it got one, from which its open's deadline counts.
// - `notifications` gains the kind `spend`: a sandbox spend alert in an Admin's bell (subject
//   `sandbox-spend:<month>:<limit>`), never a toast.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE sandbox_limits (
      audience text PRIMARY KEY DEFAULT 'admin' CHECK (audience IN ('admin')),
      awake integer NOT NULL CHECK (awake BETWEEN 1 AND 1000),
      awake_per_person integer NOT NULL CHECK (awake_per_person BETWEEN 1 AND 100),
      monthly_alert_usd integer NOT NULL CHECK (monthly_alert_usd BETWEEN 0 AND 1000000),
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE sandbox_limits REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE sandbox_generations (
      id bigserial PRIMARY KEY,
      branch_id text NOT NULL CHECK (char_length(branch_id) BETWEEN 1 AND 300),
      generation integer CHECK (generation >= 1),
      person_id text,
      kind text NOT NULL CHECK (kind IN ('branch', 'todo', 'job')),
      instance text,
      started_at timestamptz NOT NULL DEFAULT now(),
      seen_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      CHECK ((generation IS NULL) = (instance IS NULL))
    )`
  // One machine per branch: at most one open slot each.
  yield* sql`CREATE UNIQUE INDEX sandbox_generations_open ON sandbox_generations (branch_id) WHERE ended_at IS NULL`
  // Admission counts the open slots; spend reads a month's.
  yield* sql`CREATE INDEX sandbox_generations_awake ON sandbox_generations (seen_at) WHERE ended_at IS NULL`
  yield* sql`CREATE INDEX sandbox_generations_started ON sandbox_generations (started_at)`
  yield* sql`
    ALTER TABLE terminal_sessions
      ADD COLUMN waiting boolean NOT NULL DEFAULT false,
      ADD COLUMN admitted_at timestamptz`
  yield* sql`ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check`
  yield* sql`
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('run', 'main', 'release', 'clone', 'spend'))`
})
