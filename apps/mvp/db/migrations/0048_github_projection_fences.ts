import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Absence must survive even before a projection row has ever been inserted. These server-only fences serialize
// with projection writes; they are not Electric shapes. Existing tombstones retain their conservative time fence.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE github_projection_fences (
    item_id text PRIMARY KEY,
    gone_at timestamptz,
    comments_listed_at timestamptz,
    CHECK (gone_at IS NOT NULL OR comments_listed_at IS NOT NULL)
  )`
  yield* sql`INSERT INTO github_projection_fences (item_id, gone_at)
    SELECT id, GREATEST(deleted_at, fetched_at) FROM items WHERE deleted_at IS NOT NULL`
  yield* sql`UPDATE comments SET fetched_at = GREATEST(deleted_at, fetched_at) WHERE deleted_at IS NOT NULL`
  yield* sql`DELETE FROM pull_commits WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NOT NULL)`
  yield* sql`DELETE FROM reviews WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NOT NULL)`
  yield* sql`DELETE FROM pulls WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NOT NULL)`
  // A legacy positive attempt count cannot prove that a merge PUT was made, or that its answer was unknown.
  yield* sql`ALTER TABLE github_writes ADD COLUMN merge_unknown boolean NOT NULL DEFAULT false`
})
