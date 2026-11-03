import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Repository-scoped visibility claims/cooldowns share one owner across people and Worker isolates.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE github_repositories
    ADD COLUMN visibility_read_until timestamptz,
    ADD COLUMN visibility_read_failed boolean NOT NULL DEFAULT false,
    ADD COLUMN visibility_read_refusal text CHECK (visibility_read_refusal IN ('unavailable', 'rate_limited'))`
})
