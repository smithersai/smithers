import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The nonce identifies the sealed credential a call opened, even when its usage row was inserted after a replacement.
// Existing calls have no reliable identity: leave them null so they cannot mark or clear the current credential.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE personal_model_usage ADD COLUMN credential_nonce text`
})
