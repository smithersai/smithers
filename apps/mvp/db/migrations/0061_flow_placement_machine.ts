import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { placementOf } from "../../src/features/flows-ui/source.ts"

// A person's code runs in the QuickJS realm (ruling FLOW-2's addendum, docs/features/flows.md#your-own-flows):
// `flows.placement` is `sandbox` only for code that needs a machine now, where until now it was every hand edit. Each
// `sandbox` flow's placement is read again from its latest revision's source with `placementOf`, the function every
// write stores it with. A drafted flow as drafted was `client` and stays so.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const flows = yield* sql<{ readonly id: string; readonly source: string }>`
    SELECT f.id, r.source FROM flows f JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = f.revision
    WHERE f.placement = 'sandbox'`
  for (const flow of flows) {
    if (placementOf(flow.source) === "client") yield* sql`UPDATE flows SET placement = 'client' WHERE id = ${flow.id}`
  }
})
