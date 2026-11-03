import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Terminal event + successor attempts, committed with the lane change. Retrying admission never invents an attempt.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todo_attempts ADD COLUMN finished_report jsonb
    CHECK (finished_report IS NULL OR
      (jsonb_typeof(finished_report) = 'object' AND jsonb_typeof(finished_report->'event') = 'object'
        AND jsonb_typeof(finished_report->'starts') = 'array'))`
})
