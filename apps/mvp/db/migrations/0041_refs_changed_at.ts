import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// When a repository's branches or tags last changed in a way the app knows of: a clone attempt that settled ready (its
// pull may move any ref) and a branch the app made on the forge. The refs a device and RepoApi keep are keyed by it
// with the head commit, so a ref change that leaves the default branch's head where it was still reloads them
// (docs/features/repo.md#reads). Null for a row no such change has touched since.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE repositories ADD COLUMN refs_changed_at timestamptz`
})
