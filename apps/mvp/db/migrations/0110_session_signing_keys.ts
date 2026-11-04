import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Legacy is the generated SESSION_SECRET's stable id. The additive defaults preserve an old Worker's inserts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SET LOCAL lock_timeout = '5s'`
  yield* sql`CREATE TABLE session_signing_keys (
    key_id text PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('issuer', 'verifier', 'retired')),
    promoted_at timestamptz,
    ceased_at timestamptz
  )`
  yield* sql`CREATE UNIQUE INDEX session_signing_keys_one_issuer ON session_signing_keys (state) WHERE state = 'issuer'`
  yield* sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', clock_timestamp())`
  // A foreign key would acquire issuer-row locks and make a stalled promotion block issuance.
  yield* sql`ALTER TABLE sessions ADD COLUMN cookie_key text NOT NULL DEFAULT 'legacy'`
  yield* sql`ALTER TABLE host_sessions ADD COLUMN cookie_key text NOT NULL DEFAULT 'legacy'`
})
