import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Who spent the timeline's model calls, and who holds each one now (docs/features/timeline.md#cost).
//
// - `timeline_attempts`: one row per claim that started a call, never changed. The daily cap counts these. The `attempts`
//   columns they replace lived on a claim, so reclaiming moved every earlier attempt to the new person and into today.
//   Attempts outlive the message they were for, because deleting a message refunds nothing.
// - `owner` on both claim tables: the durable run holding the claim (src/features/timeline/flow.ts `ClaimOwner`). Only
//   that run records or releases it, and the same run after a crash resumes it instead of being told it is taken.
//   A claim from before this has no owner, so nobody resumes it and it is taken again after ten minutes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE timeline_attempts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      person_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('summary', 'spans')),
      message_id uuid NOT NULL,
      revision text NOT NULL CHECK (char_length(revision) <= 128),
      owner text,
      claimed_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX timeline_attempts_person_claimed ON timeline_attempts (person_id, claimed_at DESC)`
  yield* sql`
    INSERT INTO timeline_attempts (person_id, kind, message_id, revision, claimed_at)
    SELECT person_id, 'summary', message_id, revision, claimed_at FROM timeline_summaries, generate_series(1, attempts)`
  yield* sql`
    INSERT INTO timeline_attempts (person_id, kind, message_id, revision, claimed_at)
    SELECT person_id, 'spans', anchor_id, revision, claimed_at FROM timeline_phase_claims, generate_series(1, attempts)`
  yield* sql`ALTER TABLE timeline_summaries DROP COLUMN attempts, ADD COLUMN owner text`
  yield* sql`ALTER TABLE timeline_phase_claims DROP COLUMN attempts, ADD COLUMN owner text`
  yield* sql`DROP INDEX timeline_summaries_person_claimed`
  yield* sql`DROP INDEX timeline_phase_claims_person_claimed`
})
