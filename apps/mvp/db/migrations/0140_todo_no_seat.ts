import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The coding-route step may settle before a model or runner starts. Preserve the reason for Retry.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todos DROP CONSTRAINT todos_failure_check`
  yield* sql`ALTER TABLE todos ADD CONSTRAINT todos_failure_check CHECK (failure IN ('plan', 'implement', 'no_seat',
    'empty_change', 'publish_refused', 'pr_refused', 'app_not_installed', 'budget', 'base_closed', 'crashed', 'stopped'))`
})
