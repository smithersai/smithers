import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Authority is ordered before GitHub reads, independently of the check's completion/retry timestamp.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE SEQUENCE role_observations`
  yield* sql`ALTER TABLE sessions ADD COLUMN role_generation bigint`
  yield* sql`
    WITH ordered AS MATERIALIZED (
      SELECT id, nextval('role_observations') AS generation FROM (
        SELECT id FROM sessions ORDER BY role_checked_at, created_at, id
      ) receipts
    ) UPDATE sessions s SET role_generation = ordered.generation FROM ordered WHERE s.id = ordered.id`
  yield* sql`ALTER TABLE sessions ALTER COLUMN role_generation SET NOT NULL,
    ALTER COLUMN role_generation SET DEFAULT nextval('role_observations')`
})
