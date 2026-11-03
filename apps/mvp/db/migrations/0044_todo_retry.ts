import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Retrying replaces the current projection, but published descendants still reference the old attempt's branch.
  yield* sql`ALTER TABLE todo_attempts ADD COLUMN branch text CHECK (char_length(branch) <= 255)`
  yield* sql`ALTER TABLE todo_attempts ADD COLUMN pr_number integer CHECK (pr_number > 0)`
  yield* sql`ALTER TABLE stack_ops DROP CONSTRAINT stack_ops_op_check`
  yield* sql`ALTER TABLE stack_ops ADD CHECK (op IN ('commit', 'drop', 'move', 'amend', 'retry'))`
  yield* sql`ALTER TABLE stack_ops DROP CONSTRAINT stack_ops_outcome_check`
  yield* sql`ALTER TABLE stack_ops ADD CHECK (outcome IN ('committed', 'dropped', 'retried', 'stack_full', 'merged', 'not_found', 'not_retryable'))`
})
