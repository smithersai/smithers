import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Publication and update receipts use the shared attention lifecycle, independently of agent-answer runs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check`
  yield* sql`ALTER TABLE notifications DROP CONSTRAINT notifications_kind_state_check`
  yield* sql`ALTER TABLE notifications
    ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('run', 'main', 'release', 'clone', 'spend', 'bug', 'write')),
    ADD CONSTRAINT notifications_kind_state_check CHECK ((kind IN ('run', 'clone', 'write')) = (state <> 'update'))`
})
