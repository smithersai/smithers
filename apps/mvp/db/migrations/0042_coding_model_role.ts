import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The `coding` model role, the `todo` run's agent (decision 0033): an admin may set it with `admin/SetModel`; until one
// does, it answers with the `agent` role's model (worker/ModelRoles.ts).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE model_roles DROP CONSTRAINT model_roles_role_check`
  yield* sql`ALTER TABLE model_roles ADD CONSTRAINT model_roles_role_check
    CHECK (role IN ('agent', 'coding', 'renderer', 'judge', 'summary'))`
})
