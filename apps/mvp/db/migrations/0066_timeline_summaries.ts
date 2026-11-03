import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The timeline's one-line summaries, made once per message for every device (docs/features/timeline.md#cost). On
// smithers.sh on 2026-10-25 every tab, device and fresh browser kept its own copy and made its own, so the same 15
// messages were summarized again in every burst: 350 calls on a person's own key in 50 minutes against 19 answers.
//
// - `messages.summary` and `summary_revision`: an answer's summary and the content identity it was made from
//   (src/features/timeline/identity.ts `revisionOf`). Synced with the message, so every device that shows it shows the
//   summary, and none asks again. Both are set together, once the claim's summary is recorded.
// - `timeline_summaries`: the claims. A row is the one call a message's revision may cost: who claimed it, why the
//   model was needed (`reason`, never content), and when it was recorded. The primary key makes a second claim, from
//   any tab, device or person, a no. `person_id, claimed_at` counts a person's calls against the daily cap.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE messages
      ADD COLUMN summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 96),
      ADD COLUMN summary_revision text CHECK (summary_revision IS NULL OR char_length(summary_revision) <= 128),
      ADD CONSTRAINT messages_summary_revision CHECK ((summary IS NULL) = (summary_revision IS NULL))`
  yield* sql`
    CREATE TABLE timeline_summaries (
      message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      revision text NOT NULL CHECK (char_length(revision) <= 128),
      person_id text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('long_answer', 'multiline_answer')),
      claimed_at timestamptz NOT NULL DEFAULT now(),
      recorded_at timestamptz,
      PRIMARY KEY (message_id, revision)
    )`
  yield* sql`CREATE INDEX timeline_summaries_person_claimed ON timeline_summaries (person_id, claimed_at DESC)`
})
