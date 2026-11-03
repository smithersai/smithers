import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Each clone attempt gets an id of its own (docs/features/repo.md#the-clone). `clone_id` is a UUID drawn when the
// attempt is created; it names the attempt's execution (`repo-clone:<id>:<clone_id>`) and fences its admission and
// settle. The `attempt` counter named them before, and it restarts when the table is reset or restored while the
// Durable Objects keep their executions, so a new attempt 1 collided with the old one's.
//
// A row still `cloning` was started under the counter: no execution carries its new id, so nothing would settle it.
// It settles `failed` `unavailable`, which shows Try again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // A volatile default: every existing row draws its own.
  yield* sql`ALTER TABLE repositories ADD COLUMN clone_id uuid NOT NULL DEFAULT gen_random_uuid()`
  yield* sql`
    UPDATE repositories SET status = 'failed', failure = 'unavailable', settled_at = now()
    WHERE status = 'cloning'`
})
