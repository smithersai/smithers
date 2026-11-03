import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** GitHub remains authoritative; reconciliation backfills labels for existing rows. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE items ADD COLUMN commitment text CHECK (commitment IN ('now', 'next', 'later', 'none', 'conflict'))`
  yield* sql`UPDATE github_sync SET cursor = NULL WHERE stream = 'issues'`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_op_check`
  yield* sql`ALTER TABLE github_writes ADD CONSTRAINT github_writes_op_check CHECK (op IN
    ('issue/create', 'issue/comment', 'issue/triage', 'issue/commitment', 'triage/run', 'triage/enable', 'triage/pause'))`
})
