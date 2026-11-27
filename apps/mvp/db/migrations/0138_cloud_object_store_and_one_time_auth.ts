import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE cloud_objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_id text NOT NULL CHECK (octet_length(repo_id) BETWEEN 3 AND 256),
      namespace text NOT NULL CHECK (namespace IN ('artifact', 'audit-report', 'wiki', 'mythical', 'cache', 'changeset')),
      object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 200),
      r2_key text NOT NULL CHECK (octet_length(r2_key) BETWEEN 1 AND 512),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      content_type text NOT NULL CHECK (octet_length(content_type) BETWEEN 1 AND 128),
      bytes bigint NOT NULL CHECK (bytes >= 0),
      visibility text NOT NULL DEFAULT 'repo_members' CHECK (visibility IN ('public', 'repo_members', 'owner_only')),
      execution_trust text NOT NULL CHECK (execution_trust IN ('trusted_sandbox', 'trusted_maintainer', 'untrusted_contributor')),
      gate_eligible boolean NOT NULL DEFAULT false,
      commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-fA-F]{7,64}$'),
      ref_name text CHECK (ref_name IS NULL OR octet_length(ref_name) BETWEEN 1 AND 255),
      run_id text CHECK (run_id IS NULL OR octet_length(run_id) BETWEEN 1 AND 256),
      created_by_person_id uuid REFERENCES people (id) ON DELETE SET NULL,
      created_by_login text CHECK (created_by_login IS NULL OR octet_length(created_by_login) BETWEEN 1 AND 100),
      approved_public_by text CHECK (approved_public_by IS NULL OR octet_length(approved_public_by) BETWEEN 1 AND 100),
      inline_body bytea,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repo_id, namespace, object_key)
    )`
  yield* sql`CREATE INDEX cloud_objects_repo_ns_idx ON cloud_objects (repo_id, namespace, updated_at DESC)`
  yield* sql`CREATE INDEX cloud_objects_trust_idx ON cloud_objects (repo_id, namespace, execution_trust, updated_at DESC)`

  yield* sql`
    CREATE TABLE one_time_auth_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_sha256 text UNIQUE NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      repo_id text NOT NULL CHECK (octet_length(repo_id) BETWEEN 3 AND 256),
      person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
      minted_by_login text NOT NULL CHECK (octet_length(minted_by_login) BETWEEN 1 AND 100),
      purpose text NOT NULL CHECK (purpose IN ('sandbox', 'agent', 'ci')),
      execution_trust text NOT NULL CHECK (execution_trust IN ('trusted_sandbox', 'trusted_maintainer', 'untrusted_contributor')),
      scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4),
      client_name text NOT NULL CHECK (octet_length(client_name) BETWEEN 1 AND 120),
      label text CHECK (label IS NULL OR octet_length(label) BETWEEN 1 AND 120),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      redeemed_at timestamptz,
      redeemed_token_id uuid REFERENCES mcp_tokens (id) ON DELETE SET NULL
    )`
  yield* sql`CREATE INDEX one_time_auth_unredeemed_idx ON one_time_auth_tokens (expires_at) WHERE redeemed_at IS NULL`

  yield* sql`
    CREATE TABLE changeset_stacks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_id text NOT NULL CHECK (octet_length(repo_id) BETWEEN 3 AND 256),
      stack_key text NOT NULL CHECK (octet_length(stack_key) BETWEEN 1 AND 120),
      position integer NOT NULL CHECK (position >= 1 AND position <= 500),
      title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 256),
      summary text NOT NULL DEFAULT '' CHECK (octet_length(summary) <= 8000),
      branch_name text NOT NULL CHECK (octet_length(branch_name) BETWEEN 1 AND 255),
      base_branch text NOT NULL DEFAULT 'main' CHECK (octet_length(base_branch) BETWEEN 1 AND 255),
      head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-fA-F]{7,64}$'),
      pr_number integer CHECK (pr_number IS NULL OR pr_number >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'verified', 'merged', 'abandoned')),
      execution_trust text NOT NULL DEFAULT 'untrusted_contributor' CHECK (execution_trust IN ('trusted_sandbox', 'trusted_maintainer', 'untrusted_contributor')),
      gate_status text NOT NULL DEFAULT 'pending' CHECK (gate_status IN ('pending', 'passed', 'failed', 'untrusted_only')),
      author_person_id uuid REFERENCES people (id) ON DELETE SET NULL,
      author_login text NOT NULL CHECK (octet_length(author_login) BETWEEN 1 AND 100),
      artifact_ref text CHECK (artifact_ref IS NULL OR octet_length(artifact_ref) <= 256),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repo_id, stack_key, position)
    )`
  yield* sql`CREATE INDEX changeset_stacks_repo_idx ON changeset_stacks (repo_id, stack_key, position ASC)`

  yield* sql`
    CREATE TABLE mythical_commits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_id text NOT NULL CHECK (octet_length(repo_id) BETWEEN 3 AND 256),
      position integer NOT NULL CHECK (position >= 1),
      epic text NOT NULL CHECK (octet_length(epic) BETWEEN 1 AND 120),
      title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 256),
      summary text NOT NULL DEFAULT '' CHECK (octet_length(summary) <= 8000),
      commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-fA-F]{7,64}$'),
      main_folded_sha text CHECK (main_folded_sha IS NULL OR main_folded_sha ~ '^[0-9a-fA-F]{7,64}$'),
      tree_equal_to_main boolean NOT NULL DEFAULT false,
      pr_number integer CHECK (pr_number IS NULL OR pr_number >= 1),
      notes jsonb NOT NULL DEFAULT '[]'::jsonb,
      author_login text NOT NULL CHECK (octet_length(author_login) BETWEEN 1 AND 100),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repo_id, position)
    )`
  yield* sql`CREATE INDEX mythical_commits_repo_idx ON mythical_commits (repo_id, position DESC)`

  yield* sql`
    CREATE TABLE repo_contributors (
      repo_id text NOT NULL CHECK (octet_length(repo_id) BETWEEN 3 AND 256),
      github_login text NOT NULL CHECK (octet_length(github_login) BETWEEN 1 AND 100),
      contribution_count integer NOT NULL DEFAULT 1 CHECK (contribution_count >= 1),
      first_contribution_at timestamptz NOT NULL DEFAULT now(),
      last_contribution_at timestamptz NOT NULL DEFAULT now(),
      last_kind text NOT NULL DEFAULT 'pr' CHECK (last_kind IN ('pr', 'commit', 'issue', 'changeset', 'artifact', 'audit')),
      PRIMARY KEY (repo_id, github_login)
    )`
  yield* sql`CREATE INDEX repo_contributors_login_idx ON repo_contributors (github_login)`
})
