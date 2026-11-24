import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Fleet session observability upgrade: canonical project, human-readable summary,
// working directory, and scrubbed recent transcript entries (OBS-5) on observed_sessions.
// Keeps REPLICA IDENTITY FULL intact for ElectricSQL shapes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE observed_sessions
      ADD COLUMN project text CHECK (char_length(project) <= 160),
      ADD COLUMN summary text CHECK (char_length(summary) <= 320),
      ADD COLUMN cwd text CHECK (char_length(cwd) <= 260),
      ADD COLUMN transcript_json jsonb
  `
  yield* sql`ALTER TABLE observed_sessions REPLICA IDENTITY FULL`
})
