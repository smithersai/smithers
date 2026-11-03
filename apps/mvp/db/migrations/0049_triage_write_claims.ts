import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// When a flow decision's label step and comment step began writing to GitHub (docs/features/issues.md#triage): a step
// records its start before it checks the issue's pin, and a person's Accept or Not accepted waits while a write that
// started is neither finished nor past its step's retries, so the person's labels land last. `NULL` for a step that
// hasn't started, and for a comment step that found the issue pinned.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE triage_decisions ADD COLUMN label_started_at timestamptz, ADD COLUMN comment_started_at timestamptz`
})
