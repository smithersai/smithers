import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Configuration cannot choose a replacement seal while existing ciphertext still depends on the original.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE session_seal_key (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    fingerprint text CHECK (fingerprint ~ '^[0-9a-f]{64}$')
  )`
  yield* sql`INSERT INTO session_seal_key (id) VALUES (true)`
})
