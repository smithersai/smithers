import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE mcp_oauth_clients (
      client_id text PRIMARY KEY CHECK (octet_length(client_id) BETWEEN 1 AND 128),
      client_name text NOT NULL CHECK (octet_length(client_name) BETWEEN 1 AND 120),
      redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 8),
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE mcp_oauth_codes (
      code_sha256 text PRIMARY KEY CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
      person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
      client_id text NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
      redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
      repo_scope text CHECK (repo_scope IS NULL OR octet_length(repo_scope) BETWEEN 1 AND 256),
      scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4),
      code_challenge text NOT NULL CHECK (octet_length(code_challenge) BETWEEN 43 AND 128),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`
  yield* sql`
    CREATE TABLE mcp_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
      client_id text NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE RESTRICT,
      client_name text NOT NULL CHECK (octet_length(client_name) BETWEEN 1 AND 120),
      token_sha256 text UNIQUE NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      repo_scope text CHECK (repo_scope IS NULL OR octet_length(repo_scope) BETWEEN 1 AND 256),
      scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_used_at timestamptz,
      revoked_at timestamptz
    )`
  yield* sql`CREATE INDEX mcp_tokens_person_active_idx ON mcp_tokens (person_id, created_at DESC) WHERE revoked_at IS NULL`
  yield* sql`CREATE INDEX mcp_oauth_codes_expires_idx ON mcp_oauth_codes (expires_at) WHERE used_at IS NULL`
})
