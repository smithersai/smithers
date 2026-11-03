import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A person's merge is a git write (decision 0012 decision 6, docs/features/pulls.md#merge): `github_writes` takes
// `pr/merge` beside every operation it took before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_op_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_op_check CHECK (op IN ('issue/create', 'issue/comment',
      'issue/triage', 'issue/commitment', 'triage/run', 'triage/enable', 'triage/pause', 'pr/merge'))`
})
