import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS waitlist_entries (
      position bigserial PRIMARY KEY,
      normalized_url text NOT NULL,
      requester text NOT NULL,
      workflow_note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (normalized_url, requester)
    )`
})
