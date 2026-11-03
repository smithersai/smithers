import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A person's draft they deleted (docs/features/flows.md#delete-a-draft): `deleted_at` marks it, so it leaves their
// devices (the shape reads only rows where it is `NULL`) and a round still running on a device can't write it back. The
// row stays for the round's late write to find: an insert would otherwise bring the draft back. Devices sync no new
// column, so they need no migration.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flow_drafts ADD COLUMN deleted_at timestamptz`
})
