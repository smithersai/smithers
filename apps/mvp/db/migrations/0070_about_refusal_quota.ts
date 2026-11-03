import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** A kept rate limit belongs to the quota that refused it, not a later authenticated read. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE repo_about ADD COLUMN refusal_via text CHECK (refusal_via IN ('app', 'deployment', 'anonymous'))`
})
