import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A pull request's base repository's default branch, as GitHub said when it was last read (ruling GH-9,
// docs/features/pulls.md#postgres): merging into it is a deploy, so the page warns beside Merge. `NULL` until the next
// read of a pull request synced before this, or when GitHub's answer didn't name it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE pulls ADD COLUMN default_branch text`
})
