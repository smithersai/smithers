import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * Empty exactly the worker fixture's conversation rows. TRUNCATE scans all of pg_constraint for incoming foreign
 * keys, even for empty tables. On the shared test server that catalog grows with every migrated/dropped schema:
 * the observed stall was IO/DataFileRead with all table locks already granted, reading a 7 GiB catalog.
 * DELETE only visits this small fixture. Keep child-first deletion and the shared position restart atomic.
 */
export const reset = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
  // These receipts intentionally have no session foreign key, so session truncation cannot reset them.
  yield* sql`DELETE FROM github_token_cleanups`
  yield* sql`DELETE FROM session_end_receipts`
  yield* sql`DELETE FROM message_pins`
  yield* sql`DELETE FROM timeline_summaries`
  yield* sql`DELETE FROM timeline_phase_claims`
  yield* sql`DELETE FROM messages`
  yield* sql`DELETE FROM view_moves`
  yield* sql`DELETE FROM views`
  // Unlike setval, RESTART rolls back with the transaction; the sequence's configured start and step are preserved.
  yield* sql`ALTER SEQUENCE messages_position_seq RESTART`
})))
