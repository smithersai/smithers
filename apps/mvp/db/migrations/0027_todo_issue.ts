import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A TODO made from an issue (docs/features/todos.md#from-an-issue): `todos.issue_number` is the number of the GitHub
// issue in the same repository the TODO was drafted from, or null. The stack's writer sets it once, on commit, and
// never changes it. Synced with the rest of the row, so the TODO shows its issue and the issue its TODOs; the `todo`
// run (decision 0016 Track B) writes "Fixes #<n>" into its pull request's body from it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE todos ADD COLUMN issue_number integer CHECK (issue_number >= 1)`
  // An issue's TODOs, as its page reads them.
  yield* sql`CREATE INDEX todos_issue ON todos (repo_id, issue_number) WHERE issue_number IS NOT NULL`
})
