import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Reconcile now reads a pull request whose `pulls` row is missing or older than the issues listing says
// (worker/github/Reconcile.ts). Clearing the issues stream's cursor makes the next walk list every issue again, so a
// pull request imported before any webhook, or whose merge webhook never came, is read once more.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE github_sync SET cursor = NULL WHERE stream = 'issues'`
})
