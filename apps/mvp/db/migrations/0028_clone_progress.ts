import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The clone as a visible workflow, and the reclaim policy (docs/features/repo.md#the-clone, #reclaiming):
//
// - `repositories.stage`: how far a `cloning` row has come: `requested` (RepoApi took it), `fetching` (admitted, Code
//   Storage fetching from GitHub) or `indexing` (the head commit is in, its file list is being read). Null otherwise.
// - `clone_requests`: who asked for each repository's current attempt (`clone_id`), the person its feed entry goes
//   to. A table of its own, so the `repositories` shape, which every device syncs whole, never carries a person.
// - `repositories.reclaimable`: a ready copy of a repository the Smithers GitHub App isn't installed on. Storage may
//   reclaim it when the budgets need room, through a flow. Rows ready before this migration are reclaimable unless the
//   App's installation on them is known.
// - `notifications` gains the kind `clone` (subject `clone:<repo id>`): the person's own clone, with a run's states.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE repositories
      ADD COLUMN stage text CHECK (stage IN ('requested', 'fetching', 'indexing')),
      ADD COLUMN reclaimable boolean NOT NULL DEFAULT false`
  yield* sql`
    CREATE TABLE clone_requests (
      repo_id text PRIMARY KEY,
      clone_id uuid NOT NULL,
      requested_by text NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 200),
      requested_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    UPDATE repositories r SET reclaimable = NOT EXISTS (
      SELECT 1 FROM github_repositories g WHERE g.repo_id = r.id AND g.installation_id IS NOT NULL)
    WHERE r.status = 'ready'`
  yield* sql`UPDATE repositories SET stage = 'fetching' WHERE status = 'cloning'`
  // The checks 0020 wrote on `kind`, found by what they say rather than by Postgres's generated names.
  yield* sql`
    DO $$
    DECLARE found record;
    BEGIN
      FOR found IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%kind = ANY%' OR pg_get_constraintdef(oid) LIKE '%state <> ''update''%')
      LOOP
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', found.conname);
      END LOOP;
    END $$`
  yield* sql`
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('run', 'main', 'release', 'clone')),
      ADD CONSTRAINT notifications_kind_state_check CHECK ((kind IN ('run', 'clone')) = (state <> 'update'))`
})
