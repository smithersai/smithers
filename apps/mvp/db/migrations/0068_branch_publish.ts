import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Publish and Update branch (docs/features/branch-publish.md, rulings GH-6 and GH-11): a Smithers-only branch reaches
// GitHub only through a person's explicit Publish, a git write like any other.
//
// - `github_writes` takes `branch/publish` and `branch/update`, and their refusals: nothing to publish
//   (`empty_change`), a change over the limits (`too_large`), a branch not yet published (`not_published`), a base
//   commit GitHub doesn't have (`base_missing`), and a change GitHub can't take (`conflict`). Each names its branch
//   (`branch_id`), which the person's devices read with the write's status; at most one Publish of a branch is pending.
// - `branch_publications`: at most one row per branch, written only by `branch/Publish` and `branch/Update`: the GitHub
//   branch it was published as, the base it was published from and its pull request, the head Smithers last wrote or
//   read, and how the last Update branch ended. `pushed` is what the pushes wrote, by path (the contents' SHA-256, or
//   null for a deletion), and `pushed_sha` the head the last push made, so a Publish again sends only what changed and
//   refuses a file GitHub changed since; `pushing_write` and `pushing_from` the push on its way and the head it commits
//   onto, recorded before it writes, so a step that runs again fences on the same head. Devices sync it per branch, to
//   anyone who may view the branch, without those four.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_op_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_op_check CHECK (op IN ('issue/create', 'issue/comment',
      'issue/triage', 'issue/commitment', 'triage/run', 'triage/enable', 'triage/pause', 'pr/merge', 'branch/publish',
      'branch/update'))`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_failure_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_failure_check
      CHECK (failure IN ('sign_in_required', 'not_allowed', 'not_found', 'invalid', 'app_not_installed', 'unavailable',
        'head_moved', 'base_moved', 'draft', 'not_mergeable', 'merged', 'closed', 'empty_change', 'too_large',
        'not_published', 'base_missing', 'conflict'))`
  // The branch a Publish or an Update acts on, which the person's devices read with the write's status.
  yield* sql`ALTER TABLE github_writes ADD COLUMN branch_id uuid`
  yield* sql`ALTER TABLE github_writes ADD CONSTRAINT github_writes_branch_check
    CHECK ((branch_id IS NOT NULL) = (op IN ('branch/publish', 'branch/update')))`
  // One Publish of a branch on its way at a time: two editors pressing at once open one pull request.
  yield* sql`
    CREATE UNIQUE INDEX github_writes_branch_publish ON github_writes (branch_id)
      WHERE op = 'branch/publish' AND status = 'pending'`
  yield* sql`
    CREATE TABLE branch_publications (
      branch_id uuid PRIMARY KEY REFERENCES branches (id),
      repo_id text NOT NULL,
      github_ref text NOT NULL CHECK (length(github_ref) BETWEEN 1 AND 255),
      base_ref text NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
      base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
      head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
      pr_number integer NOT NULL CHECK (pr_number > 0),
      write_id uuid NOT NULL UNIQUE,
      update_state text CHECK (update_state IN ('updated', 'up_to_date', 'conflict')),
      pushed jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pushed) = 'object'),
      pushed_sha text NOT NULL CHECK (pushed_sha ~ '^[0-9a-f]{40}$'),
      pushing_write uuid,
      pushing_from text CHECK (pushing_from ~ '^[0-9a-f]{40}$'),
      CHECK ((pushing_write IS NULL) = (pushing_from IS NULL)),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX branch_publications_repo ON branch_publications (repo_id)`
  yield* sql`ALTER TABLE branch_publications REPLICA IDENTITY FULL`
})
