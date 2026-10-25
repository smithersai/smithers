import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** A terminal provider quota or credit refusal, distinct from a rate limit. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages DROP CONSTRAINT messages_failure_check`
  yield* sql`ALTER TABLE messages ADD CONSTRAINT messages_failure_check
    CHECK (failure IN ('quota', 'rate_limited', 'model_error', 'empty', 'abandoned', 'unfinished'))`
})
