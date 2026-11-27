import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Contributor repository forks created through Smithers (decision 0175).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_forks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      upstream_repo_id text NOT NULL,
      upstream_owner text NOT NULL,
      upstream_name text NOT NULL,
      fork_owner text NOT NULL,
      fork_name text NOT NULL,
      fork_repo_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('forking', 'ready', 'failed')),
      failure text,
      app_installed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (person_id, upstream_repo_id)
    )`
  yield* sql`
    CREATE INDEX IF NOT EXISTS repo_forks_fork_repo_idx
    ON repo_forks (fork_repo_id)`
})
