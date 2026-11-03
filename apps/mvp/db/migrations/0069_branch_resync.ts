import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Resync (docs/features/branch-publish.md#resync, ruling GH-6): a published branch's Smithers branch and working copy
// follow the head its GitHub branch reached, after each Publish and Update branch and when a person or the agent asks.
//
// - `github_writes` takes `branch/resync`, which names its branch; one Publish or Resync of a branch is on its way at a
//   time (the route checks both; Postgres holds each to one).
// - `branch_publications` gains how the working copy follows GitHub: `synced_sha`, the GitHub commit it was last brought
//   to, which a Publish again measures from; `sync_state`, `synced` or `conflict`, and `sync_conflicts`, the files a
//   conflict listed (devices sync all three); `syncing`, the co-edited texts a resync on its way brings along, by path
//   (their contents' SHA-256 before it), recorded before the working copy changes and never synced.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_op_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_op_check CHECK (op IN ('issue/create', 'issue/comment',
      'issue/triage', 'issue/commitment', 'triage/run', 'triage/enable', 'triage/pause', 'pr/merge', 'branch/publish',
      'branch/update', 'branch/resync'))`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_branch_check`
  yield* sql`ALTER TABLE github_writes ADD CONSTRAINT github_writes_branch_check
    CHECK ((branch_id IS NOT NULL) = (op IN ('branch/publish', 'branch/update', 'branch/resync')))`
  yield* sql`
    CREATE UNIQUE INDEX github_writes_branch_resync ON github_writes (branch_id)
      WHERE op = 'branch/resync' AND status = 'pending'`
  yield* sql`ALTER TABLE branch_publications ADD COLUMN synced_sha text CHECK (synced_sha ~ '^[0-9a-f]{40}$')`
  yield* sql`ALTER TABLE branch_publications ADD COLUMN sync_state text CHECK (sync_state IN ('synced', 'conflict'))`
  yield* sql`
    ALTER TABLE branch_publications ADD COLUMN sync_conflicts jsonb
      CHECK (sync_conflicts IS NULL OR jsonb_typeof(sync_conflicts) = 'array')`
  yield* sql`
    ALTER TABLE branch_publications ADD COLUMN syncing jsonb CHECK (syncing IS NULL OR jsonb_typeof(syncing) = 'object')`
})
