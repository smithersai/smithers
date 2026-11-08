import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE session_signing_keys DROP CONSTRAINT session_signing_keys_state_check`
  yield* sql`ALTER TABLE session_signing_keys ADD CONSTRAINT session_signing_keys_state_check
    CHECK (state IN ('issuer', 'verifier', 'retired', 'compromised'))`
})
