import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE agent_jobs ADD COLUMN settled_claim uuid`
  yield* sql`CREATE TABLE mcp_registration_admissions (
    network_digest text NOT NULL,
    admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  yield* sql`CREATE INDEX mcp_registration_admissions_time ON mcp_registration_admissions (admitted_at)`
})
