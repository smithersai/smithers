import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The browser's agent answers (decision 0011, docs/features/agent.md), and ChatApi no longer does, so its sweep's
// index and its streaming attempts go. An answer ChatApi left `streaming` has no run left to finish it, and it would
// hold up every later answer's turn, so it settles as `failed`, `abandoned`. The turn wait (worker/Answers.ts) reads
// the streaming answers before an answer by position.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE messages SET status = 'failed', failure = 'abandoned', updated_at = now()
    WHERE status = 'streaming'`
  yield* sql`DROP INDEX messages_streaming`
  yield* sql`ALTER TABLE messages DROP COLUMN attempts`
  yield* sql`CREATE INDEX messages_streaming_position ON messages (position) WHERE status = 'streaming'`
})
