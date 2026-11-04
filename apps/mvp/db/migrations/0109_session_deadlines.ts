import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The default keeps old Workers' inserts valid. Backfill from the original sign-in, never the deployment time.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SET LOCAL lock_timeout = '5s'`
  yield* sql`ALTER TABLE sessions ADD COLUMN started_at timestamptz`
  yield* sql`UPDATE sessions SET started_at = created_at`
  yield* sql`ALTER TABLE sessions ALTER COLUMN started_at SET NOT NULL, ALTER COLUMN started_at SET DEFAULT now()`
  yield* sql`ALTER TABLE host_sessions ADD COLUMN started_at timestamptz`
  yield* sql`UPDATE host_sessions SET started_at = created_at`
  yield* sql`ALTER TABLE host_sessions ALTER COLUMN started_at SET NOT NULL, ALTER COLUMN started_at SET DEFAULT now()`
})
