import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Decision 0014 §1's skeleton tables (docs/features/flows.md#your-own-flows): a person's own flows, each saved revision
// of one, and the drafts `flow/new` writes round by round. Written when a person's flow was a `SKILL.md`; 0025 made every
// revision and draft flow source, as Will ruled on 2026-10-20. `owner_id` and `actor_id` are the signed-in person's
// id as sign-in resolves it, text as `runs.launched_by` is, because a local developer's id isn't a uuid.
//
// - `flows`: one row per name a person owns. `revision` is the latest saved one; `deleted_at` hides it from every
//   catalog while runs that pinned a revision keep reading `flow_revisions`.
// - `flow_revisions`: append-only. A run pins `(flow_id, revision)`, and `digest` is the SHA-256 of `source`, which the
//   engine checks before it runs the instructions.
// - `flow_drafts`: what the draft card shows. Only `flow/new`'s steps and the person's answers write it; its files reach
//   only its author.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE flows (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$'),
      revision integer NOT NULL CHECK (revision >= 1),
      description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  // One live flow per name per person; a deleted one frees its name.
  yield* sql`CREATE UNIQUE INDEX flows_owner_name ON flows (owner_id, name) WHERE deleted_at IS NULL`
  yield* sql`CREATE INDEX flows_owner ON flows (owner_id)`
  yield* sql`ALTER TABLE flows REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE flow_revisions (
      flow_id uuid NOT NULL REFERENCES flows (id),
      revision integer NOT NULL CHECK (revision >= 1),
      digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
      source text NOT NULL CHECK (octet_length(source) <= 65536),
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (flow_id, revision)
    )`
  yield* sql`
    CREATE TABLE flow_drafts (
      id uuid PRIMARY KEY,
      actor_id text NOT NULL,
      scope text NOT NULL CHECK (scope IN ('person', 'repo')),
      repo_id text,
      target text NOT NULL DEFAULT 'flow' CHECK (target IN ('flow', 'home')),
      name text,
      request text NOT NULL CHECK (length(request) BETWEEN 1 AND 4096),
      status text NOT NULL CHECK (status IN ('drafting', 'needs_you', 'ready', 'failed', 'saved', 'proposed')),
      round integer NOT NULL DEFAULT 0 CHECK (round >= 0),
      summary text,
      files jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(files) = 'array' AND octet_length(files::text) <= 70000),
      checks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checks) = 'array'),
      questions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 5),
      failure text,
      flow_id uuid REFERENCES flows (id),
      pull_number integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((scope = 'repo') = (repo_id IS NOT NULL))
    )`
  yield* sql`CREATE INDEX flow_drafts_actor ON flow_drafts (actor_id)`
  yield* sql`ALTER TABLE flow_drafts REPLICA IDENTITY FULL`
})
