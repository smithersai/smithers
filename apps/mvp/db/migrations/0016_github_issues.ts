import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Decision 0012 slice G0 (docs/features/issues.md#postgres): GitHub is the truth and these tables are its projection.
// Only the server's GitHub flows write `items` and `comments`; devices read them through Electric.
//
// - `items`: a repository's issues, one row per number, keyed `<repo_id>#<number>`. `source_updated_at` is GitHub's
//   `updated_at` and `fetched_at` when the server read it: a row changes only for a read newer on that pair, so a
//   duplicate or reordered delivery is harmless. `deleted_at` tombstones an issue GitHub no longer has here (deleted
//   or transferred). `write_id` is the hidden marker's write id when Smithers wrote it.
// - `comments`: their conversation comments, keyed `<repo_id>/comment/<GitHub's id>`.
// - `github_writes`: every write a person or the agent asked for, keyed by the write id the device picked. The payload
//   and the session stay on the server; a device syncs its own rows' status (`actor_id`). `attempts` counts calls to
//   GitHub, so a retry after an unknown outcome looks for its marker before writing again.
// - `github_sync`: each repository's sync cursor, when it last finished, and whether that walk was complete.
// - `github_deliveries`: one row per webhook delivery id, never its payload. Not synced.
// - `github_repositories`: what GitHub said of each synced repository: its id, whether it is private (a signed-out read
//   is served only for a repository GitHub said is public), and the App's installation covering it, so a step mints a
//   token without asking. Not synced.
//
// `actor_id` is text, as `runs.launched_by` is: a local developer's id isn't a uuid.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE items (
      id text PRIMARY KEY,
      repo_id text NOT NULL,
      number integer NOT NULL CHECK (number >= 1),
      kind text NOT NULL CHECK (kind IN ('issue', 'pull')),
      github_id bigint NOT NULL,
      title text NOT NULL,
      body text NOT NULL DEFAULT '',
      state text NOT NULL CHECK (state IN ('open', 'closed')),
      state_reason text,
      author_login text,
      comments integer NOT NULL DEFAULT 0 CHECK (comments >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      closed_at timestamptz,
      deleted_at timestamptz,
      write_id uuid,
      source_updated_at timestamptz NOT NULL,
      fetched_at timestamptz NOT NULL,
      UNIQUE (repo_id, number)
    )`
  yield* sql`CREATE INDEX items_repo ON items (repo_id)`
  yield* sql`CREATE INDEX items_write ON items (write_id) WHERE write_id IS NOT NULL`
  yield* sql`ALTER TABLE items REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE comments (
      id text PRIMARY KEY,
      repo_id text NOT NULL,
      item_id text NOT NULL,
      github_id bigint NOT NULL,
      author_login text,
      body text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      deleted_at timestamptz,
      write_id uuid,
      source_updated_at timestamptz NOT NULL,
      fetched_at timestamptz NOT NULL
    )`
  yield* sql`CREATE INDEX comments_repo ON comments (repo_id)`
  yield* sql`CREATE INDEX comments_item ON comments (item_id)`
  yield* sql`ALTER TABLE comments REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE github_writes (
      id uuid PRIMARY KEY,
      repo_id text NOT NULL,
      actor_id text NOT NULL,
      session_id uuid,
      via text NOT NULL CHECK (via IN ('person', 'agent')),
      op text NOT NULL CHECK (op IN ('issue/create', 'issue/comment')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'refused')),
      failure text CHECK (failure IN ('sign_in_required', 'not_allowed', 'not_found', 'invalid',
        'app_not_installed', 'unavailable')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      item_number integer,
      github_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      CHECK ((status IN ('failed', 'refused')) = (failure IS NOT NULL)),
      CHECK ((status = 'pending') = (settled_at IS NULL)),
      CHECK (via = 'agent' OR session_id IS NOT NULL)
    )`
  // The shape reads one person's rows.
  yield* sql`CREATE INDEX github_writes_actor ON github_writes (actor_id)`
  yield* sql`ALTER TABLE github_writes REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE github_sync (
      repo_id text NOT NULL,
      stream text NOT NULL,
      cursor text,
      synced_at timestamptz,
      complete boolean NOT NULL DEFAULT false,
      failure text,
      PRIMARY KEY (repo_id, stream)
    )`
  yield* sql`ALTER TABLE github_sync REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE github_deliveries (
      delivery_id text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
      event text NOT NULL,
      action text,
      repo_id text,
      subject integer,
      received_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE github_repositories (
      repo_id text PRIMARY KEY,
      github_id bigint,
      private boolean,
      installation_id bigint,
      checked_at timestamptz NOT NULL DEFAULT now()
    )`
})
