import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todos ADD COLUMN base_reset boolean NOT NULL DEFAULT false`
  yield* sql`ALTER TABLE todo_attempts ADD COLUMN base_ref text CHECK (char_length(base_ref) <= 255)`
  // Keep existing active attempts reachable if a predecessor closes before their next writer report.
  yield* sql`UPDATE todo_attempts a SET branch = coalesce(a.branch, t.branch),
    base_ref = t.base_ref, pr_number = coalesce(a.pr_number, t.pr_number)
    FROM todos t WHERE a.todo_id = t.id AND a.ordinal = t.attempt AND t.branch IS NOT NULL`
})
