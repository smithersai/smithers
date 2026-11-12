import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Each revision's own name (worker/PersonalFlows.ts, docs/features/flows.md#your-own-flows): a save can rename a flow,
// so `flows.name` is only its latest revision's name, and a pinned Retry of an older revision must read the name that
// revision was written under. Every revision was checked against its name when it was written, so the tag its default
// export's `Flow.make("<name>", …)` declares is that name; a revision whose tag doesn't read takes the flow's name.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flow_revisions ADD COLUMN name text CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$')`
  yield* sql`
    UPDATE flow_revisions r
    SET name = coalesce(substring(r.source FROM 'export default Flow\\.make\\("([a-z][a-z0-9-]{0,63})"'), f.name)
    FROM flows f WHERE f.id = r.flow_id`
  yield* sql`ALTER TABLE flow_revisions ALTER COLUMN name SET NOT NULL`
})
