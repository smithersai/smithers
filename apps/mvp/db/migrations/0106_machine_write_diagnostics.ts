import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A write's own receipt carries its safe refusal check and available GitHub status, without upstream content.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE machine_writes ADD COLUMN cause text, ADD COLUMN github_status integer`
})
