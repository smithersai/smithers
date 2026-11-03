import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE model_roles DROP CONSTRAINT model_roles_role_check`
  yield* sql`ALTER TABLE model_roles ADD CONSTRAINT model_roles_role_check CHECK (role IN ('agent', 'renderer', 'judge', 'summary'))`
})
