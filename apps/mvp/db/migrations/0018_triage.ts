import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Issue triage (decision 0012 §5 and §6, docs/features/issues.md#triage). GitHub is the truth: an issue's triage state is
// two labels, `smithers:accepted` and `smithers:not-accepted`, and `items.triage` is what the labels said at the last
// read (neither: `proposed`; both: `conflict`).
//
// - `items.triage`: derived from GitHub's labels on every upsert, never written on its own.
// - `items.triage_pinned`: a person overrode triage (Accept or Not accepted), so the flow never re-decides the issue
//   until a person presses Run triage again. Smithers' own state: no GitHub read changes it.
// - `triage_settings`: one row per repository a Maintainer enabled triage on: who enabled it (the flow acts under their
//   role, re-checked at every write), whether it is paused and why, and the flow's daily model budget in tokens.
// - `triage_decisions`: one row per decision, the flow's or a person's: what was decided and why (a reason code), the
//   guidelines' SHA, what the decision read (`input_digest`, the triage state then), the tokens it spent, and the label
//   and comment as separate receipts. `dropped` says why a decision wrote nothing. Not synced.
// - `github_writes` takes the triage writes: a person's override (`issue/triage`), Run triage again (`triage/run`) and
//   Enable and Pause (`triage/enable`, `triage/pause`). Only the override writes to GitHub with the person's token, so
//   only it needs their session.
//
// Rows read before this migration say `proposed` until their next read; the issues stream's cursor is cleared so the
// next reconcile walk reads every issue again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE items ADD COLUMN triage text NOT NULL DEFAULT 'proposed'
      CHECK (triage IN ('proposed', 'accepted', 'not_accepted', 'conflict'))`
  yield* sql`ALTER TABLE items ADD COLUMN triage_pinned boolean NOT NULL DEFAULT false`
  yield* sql`UPDATE github_sync SET cursor = NULL WHERE stream = 'issues'`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_op_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_op_check
      CHECK (op IN ('issue/create', 'issue/comment', 'issue/triage', 'triage/run', 'triage/enable', 'triage/pause'))`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_check2`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_session_check
      CHECK (via = 'agent' OR session_id IS NOT NULL OR op IN ('triage/run', 'triage/enable', 'triage/pause'))`
  yield* sql`
    CREATE TABLE triage_settings (
      repo_id text PRIMARY KEY,
      enabled_by text NOT NULL,
      enabled_login text,
      enabled_at timestamptz NOT NULL,
      paused boolean NOT NULL DEFAULT false,
      paused_reason text CHECK (paused_reason IN ('person', 'enabler_demoted')),
      daily_tokens integer NOT NULL CHECK (daily_tokens > 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (paused = (paused_reason IS NOT NULL))
    )`
  yield* sql`ALTER TABLE triage_settings REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE triage_decisions (
      id uuid PRIMARY KEY,
      repo_id text NOT NULL,
      item_id text NOT NULL,
      number integer NOT NULL CHECK (number >= 1),
      via text NOT NULL CHECK (via IN ('flow', 'person', 'github')),
      decided_by text,
      run_id text,
      write_id uuid,
      guidelines_sha text,
      input_digest text,
      triage_before text CHECK (triage_before IN ('proposed', 'accepted', 'not_accepted', 'conflict')),
      decision text NOT NULL CHECK (decision IN ('accept', 'reject', 'abstain')),
      reason text,
      abstained text,
      tokens integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
      labeled_at timestamptz,
      comment_github_id bigint,
      comment_failed boolean NOT NULL DEFAULT false,
      dropped text CHECK (dropped IN ('off', 'paused', 'pinned', 'relabeled', 'edited', 'gone', 'enabler_demoted',
        'refused')),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((decision = 'abstain') = (abstained IS NOT NULL))
    )`
  // Today's spend of a repository's flow decisions: the budget check.
  yield* sql`CREATE INDEX triage_decisions_spend ON triage_decisions (repo_id, created_at) WHERE via = 'flow'`
})
