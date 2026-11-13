import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { placementOf } from "../../src/features/flows-ui/source.ts"

// Stored placement drives the Run button. Re-read the latest revision with the syntax reader so examples no longer
// disable client flows, and actual inline machine declarations require a sandbox before a person starts a run.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const flows = yield* sql<{ readonly id: string; readonly source: string; readonly placement: string; readonly revision: number }>`
    SELECT f.id, f.placement, f.revision, r.source FROM flows f
    JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = f.revision`
  for (const flow of flows) {
    const placement = placementOf(flow.source)
    if (placement !== flow.placement) {
      yield* sql`UPDATE flows SET placement = ${placement}
        WHERE id = ${flow.id} AND revision = ${flow.revision} AND placement = ${flow.placement}`
    }
  }
})
