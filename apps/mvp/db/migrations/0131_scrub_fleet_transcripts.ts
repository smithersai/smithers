import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Fleet rows written before Smithers machine tokens were redacted (R2-Astra-D4-001), and the staging table for
// chunked replacement snapshots (R2-Astra-D4-011).
//
// A transcript stored before this migration was scrubbed by a pattern that missed a bare machine token (`smm_`) and a
// scoped token (`smt1.`), and Electric serves the column as stored. Every stored transcript is cleared, so no pattern
// has to be trusted with old text: a host that still runs reports each live session's transcript again on its next
// sync, through the current rules. The short texts beside it keep everything but the tokens.
//
// Every statement can run again without changing more.
const TOKEN = "smm_[A-Za-z0-9_-]{8,}|smt1[.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)?"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE observed_sessions SET transcript_json = NULL WHERE transcript_json IS NOT NULL`
  yield* sql`
    UPDATE observed_sessions SET
      title = regexp_replace(title, ${TOKEN}, '[redacted]', 'g'),
      summary = regexp_replace(summary, ${TOKEN}, '[redacted]', 'g'),
      lane = regexp_replace(lane, ${TOKEN}, '[redacted]', 'g'),
      repo = regexp_replace(repo, ${TOKEN}, '[redacted]', 'g'),
      project = regexp_replace(project, ${TOKEN}, '[redacted]', 'g'),
      cwd = regexp_replace(cwd, ${TOKEN}, '[redacted]', 'g'),
      model = regexp_replace(model, ${TOKEN}, '[redacted]', 'g'),
      account_label = regexp_replace(account_label, ${TOKEN}, '[redacted]', 'g')
    WHERE concat_ws(' ', title, summary, lane, repo, project, cwd, model, account_label) ~ ${TOKEN}
  `
  // The session keys each chunk of a replacement snapshot named, until its final chunk reconciles them. Never
  // replicated: no Electric shape reads it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_session_snapshot_keys (
      node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 128),
      snapshot_id text NOT NULL CHECK (char_length(snapshot_id) BETWEEN 1 AND 128),
      session_key text NOT NULL CHECK (char_length(session_key) BETWEEN 1 AND 256),
      staged_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, snapshot_id, session_key)
    )`
})
