import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// TODOs and the stack (decision 0016 §1, docs/features/todos.md#postgres). Only the stack's writer
// (worker/stack/Stack.ts) writes these tables, one short transaction per change that locks the repository's `stacks`
// row first.
//
// - `stacks`: one row per repository: the next TODO number, a version that counts changes, how many TODOs work at once
//   (`lanes`) and how many may be open (`max_open`). Not synced.
// - `todos`: a TODO, numbered per repository and never renumbered. `position` orders the open ones from 1; a merged or
//   dropped TODO has none. The position's uniqueness is checked at the end of each statement, so one statement can
//   close a gap. Synced to Members of the repository.
// - `todo_requests`: each revision of a TODO's prompt and acceptance criteria, never changed. Synced like `todos`.
// - `todo_attempts`: each run of a TODO; its id is the run's execution id. Not synced in slice 1's Track A.
// - `stack_ops`: the receipt of each change by its op id, so a repeated op answers the same and another payload under
//   the same id is refused. Never synced.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE stacks (
      repo_id text PRIMARY KEY CHECK (char_length(repo_id) BETWEEN 1 AND 300),
      next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
      version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
      lanes integer NOT NULL DEFAULT 1 CHECK (lanes BETWEEN 1 AND 8),
      max_open integer NOT NULL DEFAULT 50 CHECK (max_open BETWEEN 1 AND 500),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE todos (
      id uuid PRIMARY KEY,
      repo_id text NOT NULL REFERENCES stacks (repo_id),
      number integer NOT NULL CHECK (number >= 1),
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND btrim(title) <> ''),
      state text NOT NULL CHECK (state IN ('queued', 'starting', 'working', 'needs_you', 'in_review', 'merged',
        'dropped', 'failed')),
      step text CHECK (step IN ('plan', 'implement', 'publish', 'propose', 'await')),
      position integer CHECK (position >= 1),
      revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      branch text CHECK (char_length(branch) <= 255),
      base_sha text CHECK (base_sha ~ '^[0-9a-f]{40}$'),
      head_sha text CHECK (head_sha ~ '^[0-9a-f]{40}$'),
      pr_number integer CHECK (pr_number >= 1),
      pr_draft boolean,
      merge_sha text CHECK (merge_sha ~ '^[0-9a-f]{40}$'),
      failure text CHECK (failure IN ('plan', 'implement', 'empty_change', 'publish_refused', 'pr_refused',
        'app_not_installed', 'budget')),
      note text CHECK (note IN ('merged_on_github', 'closed_on_github', 'out_of_order')),
      created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
      created_login text NOT NULL CHECK (char_length(created_login) BETWEEN 1 AND 100),
      settled_by text CHECK (char_length(settled_by) BETWEEN 1 AND 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      UNIQUE (repo_id, number),
      CONSTRAINT todos_repo_position UNIQUE (repo_id, position) DEFERRABLE INITIALLY IMMEDIATE,
      CHECK ((state IN ('merged', 'dropped')) = (position IS NULL)),
      CHECK ((state IN ('merged', 'dropped')) = (settled_at IS NOT NULL))
    )`
  yield* sql`
    CREATE TABLE todo_requests (
      todo_id uuid NOT NULL REFERENCES todos (id),
      revision integer NOT NULL CHECK (revision >= 1),
      repo_id text NOT NULL,
      prompt text NOT NULL CHECK (octet_length(prompt) <= 16384 AND btrim(prompt) <> ''),
      acceptance text[] NOT NULL DEFAULT '{}' CHECK (cardinality(acceptance) <= 20),
      by_login text NOT NULL CHECK (char_length(by_login) BETWEEN 1 AND 100),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (todo_id, revision)
    )`
  // The shape reads one repository's requests.
  yield* sql`CREATE INDEX todo_requests_repo ON todo_requests (repo_id)`
  yield* sql`
    CREATE TABLE todo_attempts (
      id uuid PRIMARY KEY,
      todo_id uuid NOT NULL REFERENCES todos (id),
      repo_id text NOT NULL,
      ordinal integer NOT NULL CHECK (ordinal >= 1),
      revision integer NOT NULL CHECK (revision >= 1),
      base_sha text CHECK (base_sha ~ '^[0-9a-f]{40}$'),
      plan text CHECK (octet_length(plan) <= 8192),
      status text NOT NULL CHECK (status IN ('running', 'published', 'proposed', 'settled', 'failed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      UNIQUE (todo_id, ordinal)
    )`
  yield* sql`
    CREATE TABLE stack_ops (
      id uuid PRIMARY KEY,
      repo_id text NOT NULL,
      actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
      via text NOT NULL CHECK (via IN ('person', 'agent')),
      op text NOT NULL CHECK (op IN ('commit', 'drop', 'move', 'amend')),
      payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      outcome text NOT NULL CHECK (outcome IN ('committed', 'dropped', 'stack_full', 'merged', 'not_found')),
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE todos REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE todo_requests REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE todo_attempts REPLICA IDENTITY FULL`
})
