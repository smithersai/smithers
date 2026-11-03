import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Pull requests (decision 0012 §6, docs/features/pulls.md#postgres): GitHub is the truth and these tables are its
// projection, as `items` is for issues. A pull request is an `items` row of kind `pull` (its title, body, state and
// author) plus a `pulls` row with what only a pull request has. Only the server's GitHub flows write them.
//
// - `pulls`: one per pull request, keyed by its `items` id (`<repo_id>#<number>`): its head and base, whether it is a
//   draft, whether and how it merged, GitHub's `mergeable_state`, and its size. The same newer-than guard as `items`.
// - `pull_commits`: its commits in order, rewritten whole at each read of the pull request.
// - `reviews`: its reviews, keyed `<repo_id>/review/<GitHub's id>`; `write_id` is the hidden marker's when Smithers
//   submitted it (a person's review, or the `review` flow's findings).
// - `runs.sha`: the commit a run works on, set when it starts, so a pull request's Checks are the runs on its head
//   (decision 0012 decision 12). Repository-wide reads take only runs with a commit.
// - `github_writes` takes a merge's refusals (its operation arrives in 0033, after 0032 rewrote the list).
// - `todos` keeps the factory's simplified states and steps (decision 0016, the factory simplified): no Starting or
//   Needs you, and the run's steps are implement, publish and await. No row ever held the dropped ones: no host ran a
//   TODO before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE pulls (
      item_id text PRIMARY KEY,
      repo_id text NOT NULL,
      number integer NOT NULL CHECK (number >= 1),
      head_ref text NOT NULL,
      head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
      base_ref text NOT NULL,
      base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
      draft boolean NOT NULL DEFAULT false,
      merged boolean NOT NULL DEFAULT false,
      merged_at timestamptz,
      merged_by text,
      merge_sha text CHECK (merge_sha ~ '^[0-9a-f]{40}$'),
      mergeable_state text,
      additions integer NOT NULL DEFAULT 0 CHECK (additions >= 0),
      deletions integer NOT NULL DEFAULT 0 CHECK (deletions >= 0),
      changed_files integer NOT NULL DEFAULT 0 CHECK (changed_files >= 0),
      commit_count integer NOT NULL DEFAULT 0 CHECK (commit_count >= 0),
      source_updated_at timestamptz NOT NULL,
      fetched_at timestamptz NOT NULL,
      UNIQUE (repo_id, number)
    )`
  yield* sql`CREATE INDEX pulls_repo ON pulls (repo_id)`
  yield* sql`CREATE INDEX pulls_head ON pulls (repo_id, head_ref)`
  yield* sql`ALTER TABLE pulls REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE pull_commits (
      item_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 1),
      repo_id text NOT NULL,
      sha text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
      headline text NOT NULL,
      author_login text,
      authored_at timestamptz,
      PRIMARY KEY (item_id, position)
    )`
  yield* sql`CREATE INDEX pull_commits_repo ON pull_commits (repo_id)`
  yield* sql`ALTER TABLE pull_commits REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE reviews (
      id text PRIMARY KEY,
      repo_id text NOT NULL,
      item_id text NOT NULL,
      github_id bigint NOT NULL,
      author_login text,
      state text NOT NULL,
      commit_sha text,
      body text NOT NULL DEFAULT '',
      submitted_at timestamptz,
      write_id uuid,
      fetched_at timestamptz NOT NULL
    )`
  yield* sql`CREATE INDEX reviews_repo ON reviews (repo_id)`
  yield* sql`CREATE INDEX reviews_item ON reviews (item_id)`
  yield* sql`ALTER TABLE reviews REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE runs ADD COLUMN sha text CHECK (sha ~ '^[0-9a-f]{40}$')`
  yield* sql`CREATE INDEX runs_repo_sha ON runs (repo_id, sha) WHERE sha IS NOT NULL`
  yield* sql`ALTER TABLE github_writes DROP CONSTRAINT github_writes_failure_check`
  yield* sql`
    ALTER TABLE github_writes ADD CONSTRAINT github_writes_failure_check
      CHECK (failure IN ('sign_in_required', 'not_allowed', 'not_found', 'invalid', 'app_not_installed', 'unavailable',
        'head_moved', 'base_moved', 'draft', 'not_mergeable', 'merged', 'closed'))`
  yield* sql`ALTER TABLE todos DROP CONSTRAINT todos_state_check`
  yield* sql`
    ALTER TABLE todos ADD CONSTRAINT todos_state_check
      CHECK (state IN ('queued', 'working', 'in_review', 'merged', 'dropped', 'failed'))`
  yield* sql`ALTER TABLE todos DROP CONSTRAINT todos_step_check`
  yield* sql`ALTER TABLE todos ADD CONSTRAINT todos_step_check CHECK (step IN ('implement', 'publish', 'await'))`
})
