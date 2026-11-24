import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE fleet_session_snapshot_receipts (
      node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 128),
      snapshot_id text NOT NULL CHECK (char_length(snapshot_id) BETWEEN 1 AND 128),
      reported integer NOT NULL CHECK (reported >= 0),
      active integer NOT NULL CHECK (active >= 0),
      completed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, snapshot_id)
    )`
  yield* sql`CREATE INDEX fleet_session_snapshot_receipts_completed ON fleet_session_snapshot_receipts (completed_at)`
})
