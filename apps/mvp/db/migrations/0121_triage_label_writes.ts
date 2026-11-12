import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// When a flow decision's label step began changing the issue's labels (docs/features/issues.md#triage): recorded after
// its checks pass and before its first label write. A retry after a label write whose answer was lost finds it and
// finishes that write, rather than read its own label as a person's relabel. `NULL` until the step writes a label.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE triage_decisions ADD COLUMN label_written_at timestamptz`
})
