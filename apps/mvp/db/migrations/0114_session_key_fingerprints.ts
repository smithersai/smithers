import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Existing keys remain unanchored until the operator verifies an independently obtained deployed cookie.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE session_signing_keys ADD COLUMN fingerprint text CHECK (fingerprint ~ '^[0-9a-f]{64}$')`
})
