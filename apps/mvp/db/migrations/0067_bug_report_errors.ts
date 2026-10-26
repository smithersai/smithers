import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Bug reports carry what went wrong in the tab lately (docs/features/bugs.md#what-a-report-carries): `errors`, the
// tab's latest error records (src/flows/errors.ts), each its time, kind, record name, stable code and trace id; a JSON
// array, empty for a report filed before it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE bug_reports
      ADD COLUMN errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array')`
})
