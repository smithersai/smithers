import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The rail's phases and arcs (ruling FE-19, decision 0138), and a summary for every message.
//
// - `messages.phase` and `messages.arc`: the phase or arc starting at this message, as JSON. On the message, so they
//   sync through its shape to everyone who may read it, and leave with it, exactly as `summary` does.
// - `timeline_phase_claims`: a row is the one model call a segmentation may cost, from any tab, device or person.
// - `timeline_summaries.released_at`: the model never answered (no model, no credit, an outage), so the claim is free
//   again. A message then still gets its summary once a model can make it, and a call that did answer is never repeated.
// - `attempts` on both: every claim counts against the daily cap, released or not, so a provider outage can't re-claim
//   the same messages for ever. The same revision claimed again adds to its row.
// - Its `reason` now names a question or an answer: every settled message gets a summary; the old reasons stay for rows
//   already claimed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE messages
      ADD COLUMN phase text CHECK (phase IS NULL OR char_length(phase) <= 512),
      ADD COLUMN arc text CHECK (arc IS NULL OR char_length(arc) <= 512)`
  yield* sql`ALTER TABLE timeline_summaries DROP CONSTRAINT timeline_summaries_reason_check`
  yield* sql`
    ALTER TABLE timeline_summaries
      ADD CONSTRAINT timeline_summaries_reason_check CHECK (reason IN ('question', 'answer', 'long_answer', 'multiline_answer')),
      ADD COLUMN released_at timestamptz,
      ADD COLUMN attempts int NOT NULL DEFAULT 1`
  yield* sql`
    CREATE TABLE timeline_phase_claims (
      anchor_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      level int NOT NULL CHECK (level IN (1, 2)),
      revision text NOT NULL CHECK (char_length(revision) <= 128),
      person_id text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      recorded_at timestamptz,
      released_at timestamptz,
      attempts int NOT NULL DEFAULT 1,
      PRIMARY KEY (anchor_id, level, revision)
    )`
  yield* sql`CREATE INDEX timeline_phase_claims_person_claimed ON timeline_phase_claims (person_id, claimed_at DESC)`
})
