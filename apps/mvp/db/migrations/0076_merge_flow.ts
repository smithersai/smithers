import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// How a merge landed its pull request (ruling BR-7, decision 0134): `github`, GitHub's own merge as the person, or
// `queue`, the person's request to the repository's own merge queue. Null for every other write, and for a merge until
// it settles `done`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE github_writes ADD COLUMN merge_flow text CHECK (merge_flow IN ('github', 'queue'))`
})
