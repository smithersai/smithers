-- Smithers MVP schema
-- Core domain schema for auth, repositories, issues, landing requests,
-- workflows, notifications, webhooks, and agent sessions.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        VARCHAR(255) NOT NULL UNIQUE,
    lower_username  VARCHAR(255) NOT NULL UNIQUE,
    email           VARCHAR(255),
    lower_email     VARCHAR(255),
    display_name    VARCHAR(255) NOT NULL DEFAULT '',
    bio             TEXT NOT NULL DEFAULT '',
    search_vector   TSVECTOR,
    avatar_url      VARCHAR(2048) NOT NULL DEFAULT '',
    wallet_address  VARCHAR(42),
    user_type       VARCHAR(32) NOT NULL DEFAULT 'user' CHECK (user_type IN ('user', 'bot', 'service')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
    prohibit_login  BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_lower_username ON users (lower_username);
CREATE UNIQUE INDEX uq_users_lower_email ON users (lower_email) WHERE lower_email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_wallet_address ON users (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX idx_users_search_vector_gin ON users USING GIN (search_vector);

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    lower_name    VARCHAR(255) NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    visibility    VARCHAR(16) NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'limited', 'private')),
    website       VARCHAR(2048) NOT NULL DEFAULT '',
    location      VARCHAR(255) NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_lower_name ON organizations (lower_name);

-- Authentication sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
    session_key   UUID PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username      VARCHAR(255) NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    data          BYTEA,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auth_sessions_user_id ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- Auth nonces (Sign in with Key)
CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce_key       VARCHAR(64) PRIMARY KEY,
    wallet_address  VARCHAR(42),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ
);

CREATE INDEX idx_auth_nonces_expires_at ON auth_nonces (expires_at);
CREATE INDEX idx_auth_nonces_wallet ON auth_nonces (wallet_address);

-- OAuth states
CREATE TABLE IF NOT EXISTS oauth_states (
    state_key       VARCHAR(64) PRIMARY KEY,
    context_hash    VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states (expires_at);

-- User email addresses
CREATE TABLE IF NOT EXISTS email_addresses (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email          VARCHAR(255) NOT NULL,
    lower_email    VARCHAR(255) NOT NULL,
    is_activated   BOOLEAN NOT NULL DEFAULT FALSE,
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, lower_email),
    UNIQUE (lower_email)
);

CREATE INDEX idx_email_addresses_user_id ON email_addresses (user_id);
CREATE UNIQUE INDEX uq_email_addresses_primary_per_user
    ON email_addresses (user_id)
    WHERE is_primary = TRUE;

-- Email verification / reset tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    token_type    VARCHAR(20) NOT NULL CHECK (token_type IN ('verify', 'reset')),
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at       TIMESTAMPTZ
);

CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens (user_id);
CREATE INDEX idx_email_verification_tokens_expires_at ON email_verification_tokens (expires_at);

-- OAuth accounts
CREATE TABLE IF NOT EXISTS oauth_accounts (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          VARCHAR(32) NOT NULL,
    provider_user_id  VARCHAR(255) NOT NULL,
    access_token_encrypted  BYTEA,
    refresh_token_encrypted BYTEA,
    expires_at        TIMESTAMPTZ,
    profile_data      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile_data) = 'object'),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts (user_id);
CREATE INDEX idx_oauth_accounts_profile_data_gin ON oauth_accounts USING GIN (profile_data);

-- SSH keys
CREATE TABLE IF NOT EXISTS ssh_keys (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL DEFAULT '',
    public_key    TEXT NOT NULL,
    fingerprint   VARCHAR(255) NOT NULL UNIQUE,
    key_type      VARCHAR(32) NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ssh_keys_user_id ON ssh_keys (user_id);
CREATE INDEX idx_ssh_keys_fingerprint ON ssh_keys (fingerprint);

-- API access tokens
CREATE TABLE IF NOT EXISTS access_tokens (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              VARCHAR(255) NOT NULL DEFAULT '',
    token_hash        VARCHAR(255) NOT NULL UNIQUE,
    token_last_eight  VARCHAR(8) NOT NULL DEFAULT '',
    scopes            TEXT NOT NULL DEFAULT '',
    last_used_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_access_tokens_user_id ON access_tokens (user_id);
CREATE INDEX idx_access_tokens_token_hash ON access_tokens (token_hash);

-- Repositories
CREATE TABLE IF NOT EXISTS repositories (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT REFERENCES users(id) ON DELETE CASCADE,
    org_id              BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    lower_name          VARCHAR(255) NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    is_public           BOOLEAN NOT NULL DEFAULT TRUE,
    default_bookmark    VARCHAR(255) NOT NULL DEFAULT 'main',
    topics              TEXT[] NOT NULL DEFAULT '{}'::text[],
    search_vector       TSVECTOR,
    next_issue_number   BIGINT NOT NULL DEFAULT 1,
    next_landing_number BIGINT NOT NULL DEFAULT 1,
    is_fork             BOOLEAN NOT NULL DEFAULT FALSE,
    fork_id             BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    is_template         BOOLEAN NOT NULL DEFAULT FALSE,
    template_id         BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
    is_mirror           BOOLEAN NOT NULL DEFAULT FALSE,
    num_stars           BIGINT NOT NULL DEFAULT 0,
    num_watches         BIGINT NOT NULL DEFAULT 0,
    num_issues          BIGINT NOT NULL DEFAULT 0,
    num_closed_issues   BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(user_id, org_id) = 1)
);

CREATE INDEX idx_repositories_user_id ON repositories (user_id);
CREATE INDEX idx_repositories_org_id ON repositories (org_id);
CREATE INDEX idx_repositories_lower_name ON repositories (lower_name);
CREATE INDEX idx_repositories_topics_gin ON repositories USING GIN (topics);
CREATE INDEX idx_repositories_search_vector_gin ON repositories USING GIN (search_vector);
CREATE UNIQUE INDEX uq_repositories_user_lower_name
    ON repositories (user_id, lower_name)
    WHERE org_id IS NULL;
CREATE UNIQUE INDEX uq_repositories_org_lower_name
    ON repositories (org_id, lower_name)
    WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS code_search_documents (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    file_path      TEXT NOT NULL,
    content        TEXT NOT NULL DEFAULT '',
    search_vector  TSVECTOR,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, file_path)
);

CREATE INDEX idx_code_search_documents_repo_path
    ON code_search_documents (repository_id, file_path);
CREATE INDEX idx_code_search_documents_search_vector_gin
    ON code_search_documents USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS search_rate_limits (
    scope           TEXT NOT NULL,
    principal_key   TEXT NOT NULL,
    tokens          DOUBLE PRECISION NOT NULL,
    last_refill_at  TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope, principal_key)
);

CREATE INDEX idx_search_rate_limits_updated_at ON search_rate_limits (updated_at);

-- Organization membership
CREATE TABLE IF NOT EXISTS org_members (
    id               BIGSERIAL PRIMARY KEY,
    organization_id  BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_user_id ON org_members (user_id);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
    id               BIGSERIAL PRIMARY KEY,
    organization_id  BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    lower_name       VARCHAR(255) NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    permission       VARCHAR(16) NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'admin')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, lower_name)
);

CREATE INDEX idx_teams_org_id ON teams (organization_id);

CREATE TABLE IF NOT EXISTS team_members (
    id          BIGSERIAL PRIMARY KEY,
    team_id     BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, user_id)
);

CREATE INDEX idx_team_members_user_id ON team_members (user_id);

CREATE TABLE IF NOT EXISTS team_repos (
    id             BIGSERIAL PRIMARY KEY,
    team_id        BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, repository_id)
);

CREATE INDEX idx_team_repos_repository_id ON team_repos (repository_id);

CREATE TABLE IF NOT EXISTS collaborators (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission     VARCHAR(16) NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, user_id)
);

CREATE INDEX idx_collaborators_user_id ON collaborators (user_id);

-- Milestones
CREATE TABLE IF NOT EXISTS milestones (
    id            BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    state         VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    due_date      TIMESTAMPTZ,
    closed_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, title)
);

CREATE INDEX idx_milestones_repo_state ON milestones (repository_id, state);

-- Issues
CREATE TABLE IF NOT EXISTS issues (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number         BIGINT NOT NULL,
    title          VARCHAR(255) NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    search_vector  TSVECTOR,
    state          VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    author_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    milestone_id   BIGINT REFERENCES milestones(id) ON DELETE SET NULL,
    comment_count  BIGINT NOT NULL DEFAULT 0,
    closed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, number)
);

CREATE INDEX idx_issues_repo_state ON issues (repository_id, state, number DESC);
CREATE INDEX idx_issues_open_partial ON issues (repository_id, number DESC) WHERE state = 'open';
CREATE INDEX idx_issues_search_vector_gin ON issues USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS issue_comments (
    id            BIGSERIAL PRIMARY KEY,
    issue_id       BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commenter      VARCHAR(255) NOT NULL DEFAULT '',
    body           TEXT NOT NULL,
    type           VARCHAR(32) NOT NULL DEFAULT 'comment',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_issue_comments_issue_id ON issue_comments (issue_id, created_at);

CREATE TABLE IF NOT EXISTS labels (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    color          VARCHAR(16) NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);

CREATE INDEX idx_labels_repo_id ON labels (repository_id);

CREATE TABLE IF NOT EXISTS issue_labels (
    issue_id     BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    label_id     BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS issue_assignees (
    issue_id     BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id, user_id)
);

-- issue_event payload schema:
-- {"type": string, "before"?: any, "after"?: any, "meta"?: object}
CREATE TABLE IF NOT EXISTS issue_events (
    id          BIGSERIAL PRIMARY KEY,
    issue_id    BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    event_type  VARCHAR(64) NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_issue_events_issue_id ON issue_events (issue_id, created_at);
CREATE INDEX idx_issue_events_payload_gin ON issue_events USING GIN (payload);

CREATE TABLE IF NOT EXISTS issue_dependencies (
    issue_id             BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    depends_on_issue_id  BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id, depends_on_issue_id),
    CHECK (issue_id <> depends_on_issue_id)
);

CREATE TABLE IF NOT EXISTS pinned_issues (
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_id       BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    pinned_by_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    position       SMALLINT NOT NULL DEFAULT 1,
    pinned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, issue_id),
    UNIQUE (repository_id, position),
    CHECK (position BETWEEN 1 AND 3)
);

-- Landing requests (jj-native)
CREATE TABLE IF NOT EXISTS landing_requests (
    id               BIGSERIAL PRIMARY KEY,
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number           BIGINT NOT NULL,
    title            VARCHAR(255) NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    state            VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'merged', 'draft', 'queued', 'landing')),
    author_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_bookmark  VARCHAR(255) NOT NULL,
    source_bookmark  VARCHAR(255) NOT NULL DEFAULT '',
    conflict_status  VARCHAR(16) NOT NULL DEFAULT 'unknown' CHECK (conflict_status IN ('clean', 'conflicted', 'unknown')),
    stack_size       BIGINT NOT NULL DEFAULT 0,
    queued_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    queued_at        TIMESTAMPTZ,
    landing_started_at TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,
    merged_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, number)
);

CREATE INDEX idx_landing_requests_repo_state ON landing_requests (repository_id, state, number DESC);
CREATE INDEX idx_landing_requests_open_partial ON landing_requests (repository_id, number DESC) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS landing_request_changes (
    id                BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    change_id         VARCHAR(255) NOT NULL,
    position_in_stack BIGINT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (landing_request_id, change_id),
    UNIQUE (landing_request_id, position_in_stack)
);

CREATE INDEX idx_landing_request_changes_lr_id ON landing_request_changes (landing_request_id, position_in_stack);

CREATE TABLE IF NOT EXISTS landing_request_reviews (
    id                BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    reviewer_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type              VARCHAR(32) NOT NULL CHECK (type IN ('pending', 'approve', 'comment', 'request_changes')),
    body              TEXT NOT NULL DEFAULT '',
    state             VARCHAR(32) NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'dismissed')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_landing_request_reviews_lr_id ON landing_request_reviews (landing_request_id, created_at);

CREATE TABLE IF NOT EXISTS landing_request_comments (
    id                BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path              TEXT NOT NULL DEFAULT '',
    line              BIGINT NOT NULL DEFAULT 0,
    side              VARCHAR(8) NOT NULL DEFAULT 'right' CHECK (side IN ('left', 'right', 'both')),
    body              TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_landing_request_comments_lr_id ON landing_request_comments (landing_request_id, created_at);

-- jj-native VCS cache tables
CREATE TABLE IF NOT EXISTS bookmarks (
    id                BIGSERIAL PRIMARY KEY,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name              VARCHAR(255) NOT NULL,
    target_change_id  VARCHAR(255) NOT NULL DEFAULT '',
    is_default        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);

CREATE UNIQUE INDEX uq_bookmarks_single_default_per_repo
    ON bookmarks (repository_id)
    WHERE is_default = TRUE;
CREATE INDEX idx_bookmarks_repo_name ON bookmarks (repository_id, name);

CREATE TABLE IF NOT EXISTS changes (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id          VARCHAR(255) NOT NULL,
    commit_id          VARCHAR(255) NOT NULL DEFAULT '',
    description        TEXT NOT NULL DEFAULT '',
    author_name        VARCHAR(255) NOT NULL DEFAULT '',
    author_email       VARCHAR(255) NOT NULL DEFAULT '',
    has_conflict       BOOLEAN NOT NULL DEFAULT FALSE,
    is_empty           BOOLEAN NOT NULL DEFAULT FALSE,
    parent_change_ids  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parent_change_ids) = 'array'),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, change_id)
);

CREATE INDEX idx_changes_repo_id_desc ON changes (repository_id, id DESC);
CREATE INDEX idx_changes_parent_change_ids_gin ON changes USING GIN (parent_change_ids);

CREATE TABLE IF NOT EXISTS conflicts (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id          VARCHAR(255) NOT NULL,
    file_path          TEXT NOT NULL,
    conflict_type      VARCHAR(32) NOT NULL CHECK (conflict_type IN ('content', 'rename', 'delete')),
    resolved           BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    resolution_method  VARCHAR(32) NOT NULL DEFAULT '' CHECK (resolution_method IN ('', 'manual', 'theirs', 'ours', 'base')),
    resolved_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, change_id, file_path)
);

CREATE INDEX idx_conflicts_repo_change ON conflicts (repository_id, change_id, file_path);
CREATE INDEX idx_conflicts_repo_change_resolved ON conflicts (repository_id, change_id, resolved);

CREATE TABLE IF NOT EXISTS protected_bookmarks (
    id                  BIGSERIAL PRIMARY KEY,
    repository_id       BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    pattern             VARCHAR(255) NOT NULL,
    require_review      BOOLEAN NOT NULL DEFAULT TRUE,
    required_approvals  BIGINT NOT NULL DEFAULT 1 CHECK (required_approvals >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, pattern)
);

CREATE INDEX idx_protected_bookmarks_repo_pattern ON protected_bookmarks (repository_id, pattern);

CREATE TABLE IF NOT EXISTS jj_operations (
    id                   BIGSERIAL PRIMARY KEY,
    repository_id        BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    operation_id         VARCHAR(255) NOT NULL,
    operation_type       VARCHAR(64) NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    parent_operation_id  VARCHAR(255) NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, operation_id)
);

CREATE INDEX idx_jj_operations_repo_created_at ON jj_operations (repository_id, created_at DESC, id DESC);

-- Reactions (issue/landing/comment targets)
CREATE TABLE IF NOT EXISTS reactions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type  VARCHAR(32) NOT NULL CHECK (target_type IN ('issue', 'issue_comment', 'landing_request', 'landing_comment')),
    target_id    BIGINT NOT NULL,
    emoji        VARCHAR(64) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, target_type, target_id, emoji)
);

CREATE INDEX idx_reactions_target ON reactions (target_type, target_id);

-- Mentions
CREATE TABLE IF NOT EXISTS mentions (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_id           BIGINT REFERENCES issues(id) ON DELETE CASCADE,
    landing_request_id BIGINT REFERENCES landing_requests(id) ON DELETE CASCADE,
    comment_type       VARCHAR(32) NOT NULL CHECK (comment_type IN ('issue_comment', 'landing_comment', 'issue_body', 'landing_body')),
    comment_id         BIGINT,
    user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
    mentioned_user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (comment_type, comment_id, mentioned_user_id)
);

CREATE INDEX idx_mentions_mentioned_user ON mentions (mentioned_user_id, created_at DESC);

-- workflow config JSON schema (object root):
-- {
--   "triggers": [{"type": "push"|"landing_request"|"schedule"|"manual", ...}],
--   "steps": [{"name": string, "run"?: string, "agent"?: object}],
--   "env"?: object
-- }
CREATE TABLE IF NOT EXISTS workflow_definitions (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    path           TEXT NOT NULL,
    config         JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, path)
);

CREATE INDEX idx_workflow_definitions_repo_id ON workflow_definitions (repository_id);
CREATE INDEX idx_workflow_definitions_config_gin ON workflow_definitions USING GIN (config);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id                     BIGSERIAL PRIMARY KEY,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    status                 VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failure', 'cancelled')),
    trigger_event          VARCHAR(64) NOT NULL,
    trigger_ref            VARCHAR(255) NOT NULL DEFAULT '',
    trigger_commit_sha     VARCHAR(255) NOT NULL DEFAULT '',
    agent_token_hash       VARCHAR(64) UNIQUE,
    agent_token_expires_at TIMESTAMPTZ,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_runs_repo_id ON workflow_runs (repository_id, created_at DESC);
CREATE INDEX idx_workflow_runs_status_partial ON workflow_runs (repository_id, created_at DESC) WHERE status IN ('queued', 'running');
CREATE INDEX idx_workflow_runs_agent_token ON workflow_runs (agent_token_hash) WHERE agent_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_steps (
    id               BIGSERIAL PRIMARY KEY,
    workflow_run_id  BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    position         BIGINT NOT NULL,
    status           VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failure', 'skipped', 'cancelled')),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_run_id, position)
);

CREATE INDEX idx_workflow_steps_run_id ON workflow_steps (workflow_run_id, position);

-- workflow task payload schema (object root):
-- {
--   "kind": string,
--   "inputs"?: object,
--   "runner"?: object
-- }
CREATE TABLE IF NOT EXISTS workflow_tasks (
    id                BIGSERIAL PRIMARY KEY,
    workflow_run_id   BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id  BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    status            VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'assigned', 'running', 'done', 'failed', 'cancelled')),
    priority          SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
    payload           JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt           INTEGER NOT NULL DEFAULT 0,
    runner_id         BIGINT,
    assigned_at       TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_tasks_pending_dequeue
    ON workflow_tasks (priority DESC, created_at ASC, id ASC, available_at ASC)
    WHERE status = 'pending';
CREATE INDEX idx_workflow_tasks_runner_id
    ON workflow_tasks (runner_id)
    WHERE runner_id IS NOT NULL;
CREATE INDEX idx_workflow_tasks_payload_gin ON workflow_tasks USING GIN (payload);

CREATE TABLE IF NOT EXISTS workflow_logs (
    id               BIGSERIAL PRIMARY KEY,
    workflow_run_id  BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    sequence         BIGINT NOT NULL,
    stream           VARCHAR(16) NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
    entry            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_step_id, sequence)
);

CREATE INDEX idx_workflow_logs_run_id ON workflow_logs (workflow_run_id, id);

CREATE TABLE IF NOT EXISTS commit_statuses (
    id               BIGSERIAL PRIMARY KEY,
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id        VARCHAR(255),
    commit_sha       VARCHAR(255),
    context          VARCHAR(255) NOT NULL,
    status           VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'success', 'failure', 'error', 'cancelled')),
    description      TEXT NOT NULL DEFAULT '',
    target_url       TEXT NOT NULL DEFAULT '',
    workflow_run_id  BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commit_statuses_repo_change ON commit_statuses (repository_id, change_id, created_at DESC);
CREATE INDEX idx_commit_statuses_repo_sha ON commit_statuses (repository_id, commit_sha, created_at DESC);

-- runner metadata schema (object root)
CREATE TABLE IF NOT EXISTS runner_pool (
    id                 BIGSERIAL PRIMARY KEY,
    name               VARCHAR(255) NOT NULL UNIQUE,
    status             VARCHAR(16) NOT NULL CHECK (status IN ('idle', 'busy', 'offline', 'draining')),
    last_heartbeat_at  TIMESTAMPTZ,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_runner_pool_status ON runner_pool (status);
CREATE INDEX idx_runner_pool_metadata_gin ON runner_pool USING GIN (metadata);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'workflow_tasks_runner_id_fkey'
    ) THEN
        ALTER TABLE workflow_tasks
            ADD CONSTRAINT workflow_tasks_runner_id_fkey
            FOREIGN KEY (runner_id) REFERENCES runner_pool(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Agent sessions/messages/parts
CREATE TABLE IF NOT EXISTS agent_sessions (
    id               UUID PRIMARY KEY,
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workflow_run_id  BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    title            VARCHAR(255) NOT NULL DEFAULT '',
    status           VARCHAR(16) NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'timed_out')),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_sessions_repo_id ON agent_sessions (repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
    id          BIGSERIAL PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    sequence    BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, sequence)
);

CREATE INDEX idx_agent_messages_session_id ON agent_messages (session_id, sequence);

-- part content schema (object root)
CREATE TABLE IF NOT EXISTS agent_parts (
    id          BIGSERIAL PRIMARY KEY,
    message_id  BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    part_index  BIGINT NOT NULL,
    part_type   VARCHAR(32) NOT NULL,
    content     JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, part_index)
);

CREATE INDEX idx_agent_parts_message_id ON agent_parts (message_id, part_index);
CREATE INDEX idx_agent_parts_content_gin ON agent_parts USING GIN (content);

-- Workspaces: one pod per user+repo (multi-PTY container)
CREATE TABLE IF NOT EXISTS workspaces (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_token_hash  TEXT,
    pod_name          VARCHAR(255) NOT NULL DEFAULT '',
    pvc_name          VARCHAR(255) NOT NULL DEFAULT '',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'starting', 'running', 'stopped', 'failed')),
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs INTEGER NOT NULL DEFAULT 1800,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE status IN ('pending', 'starting', 'running');
CREATE INDEX idx_workspaces_status ON workspaces (status) WHERE status IN ('pending', 'starting', 'running');

-- Workspace terminal sessions
CREATE TABLE IF NOT EXISTS workspace_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_sdp        TEXT NOT NULL DEFAULT '',
    runner_sdp        TEXT NOT NULL DEFAULT '',
    client_ice_candidates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(client_ice_candidates) = 'array'),
    runner_ice_candidates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(runner_ice_candidates) = 'array'),
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'starting', 'running', 'stopped', 'failed')),
    cols              INTEGER NOT NULL DEFAULT 80,
    rows              INTEGER NOT NULL DEFAULT 24,
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs INTEGER NOT NULL DEFAULT 1800,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspace_sessions_repo_id ON workspace_sessions (repository_id, created_at DESC);
CREATE INDEX idx_workspace_sessions_user_id ON workspace_sessions (user_id);
CREATE INDEX idx_workspace_sessions_workspace_id ON workspace_sessions (workspace_id);
CREATE INDEX idx_workspace_sessions_status ON workspace_sessions (status) WHERE status IN ('pending', 'starting', 'running');

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type   VARCHAR(64) NOT NULL,
    source_id     BIGINT,
    subject       VARCHAR(255) NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    status        VARCHAR(16) NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'pinned')),
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread_partial ON notifications (user_id, created_at DESC) WHERE status = 'unread';

-- Social tables
CREATE TABLE IF NOT EXISTS stars (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repository_id)
);

CREATE INDEX idx_stars_repository_id ON stars (repository_id);

CREATE TABLE IF NOT EXISTS watches (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    mode           VARCHAR(16) NOT NULL DEFAULT 'watching' CHECK (mode IN ('watching', 'ignored', 'participating')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repository_id)
);

CREATE INDEX idx_watches_repository_id ON watches (repository_id);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
    id                BIGSERIAL PRIMARY KEY,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    url               TEXT NOT NULL,
    -- Encrypted ciphertext for the webhook HMAC signing secret.
    secret            TEXT NOT NULL DEFAULT '',
    events            TEXT[] NOT NULL DEFAULT '{}'::text[],
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    last_delivery_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_repository_id ON webhooks (repository_id);
CREATE INDEX idx_webhooks_events_gin ON webhooks USING GIN (events);

-- webhook payload schema (object root)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id               BIGSERIAL PRIMARY KEY,
    webhook_id       BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type       VARCHAR(64) NOT NULL,
    payload          JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status           VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
    response_status  INTEGER,
    response_body    TEXT NOT NULL DEFAULT '',
    attempts         INTEGER NOT NULL DEFAULT 0,
    delivered_at     TIMESTAMPTZ,
    next_retry_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_webhook_id ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_pending_partial
    ON webhook_deliveries (next_retry_at, id)
    WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_payload_gin ON webhook_deliveries USING GIN (payload);

-- Search vectors and trigger maintenance
CREATE OR REPLACE FUNCTION set_repository_search_vector()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.description, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.topics, ' '), '')), 'C');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_issue_search_vector()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.body, '')), 'B');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_user_search_vector()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.username, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.display_name, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.bio, '')), 'C');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_code_search_document_vector()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.file_path, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.content, '')), 'B');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION can_view_repository(p_repository_id BIGINT, p_viewer_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM repositories r
        WHERE r.id = p_repository_id
          AND (
            r.is_public = TRUE
            OR (
              p_viewer_id > 0
              AND (
                r.user_id = p_viewer_id
                OR EXISTS (
                  SELECT 1
                  FROM org_members om
                  WHERE om.organization_id = r.org_id
                    AND om.user_id = p_viewer_id
                    AND om.role = 'owner'
                )
                OR EXISTS (
                  SELECT 1
                  FROM team_repos tr
                  JOIN team_members tm ON tm.team_id = tr.team_id
                  WHERE tr.repository_id = r.id
                    AND tm.user_id = p_viewer_id
                )
                OR EXISTS (
                  SELECT 1
                  FROM collaborators c
                  WHERE c.repository_id = r.id
                    AND c.user_id = p_viewer_id
                )
              )
            )
          )
    );
$$;

CREATE TRIGGER trg_repositories_search_vector
BEFORE INSERT OR UPDATE OF name, description, topics
ON repositories
FOR EACH ROW
EXECUTE FUNCTION set_repository_search_vector();

CREATE TRIGGER trg_issues_search_vector
BEFORE INSERT OR UPDATE OF title, body
ON issues
FOR EACH ROW
EXECUTE FUNCTION set_issue_search_vector();

CREATE TRIGGER trg_users_search_vector
BEFORE INSERT OR UPDATE OF username, display_name, bio
ON users
FOR EACH ROW
EXECUTE FUNCTION set_user_search_vector();

CREATE TRIGGER trg_code_search_documents_search_vector
BEFORE INSERT OR UPDATE OF file_path, content
ON code_search_documents
FOR EACH ROW
EXECUTE FUNCTION set_code_search_document_vector();

UPDATE repositories
SET search_vector =
    setweight(to_tsvector('simple', COALESCE(name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(description, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(array_to_string(topics, ' '), '')), 'C');

UPDATE issues
SET search_vector =
    setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(body, '')), 'B');

UPDATE users
SET search_vector =
    setweight(to_tsvector('simple', COALESCE(username, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(display_name, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(bio, '')), 'C');

UPDATE code_search_documents
SET search_vector =
    setweight(to_tsvector('simple', COALESCE(file_path, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(content, '')), 'B');

-- Atomic per-repository issue number allocation
CREATE OR REPLACE FUNCTION get_next_issue_number(repo_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    next_num BIGINT;
BEGIN
    UPDATE repositories
    SET next_issue_number = next_issue_number + 1,
        updated_at = NOW()
    WHERE id = repo_id
    RETURNING next_issue_number - 1 INTO next_num;

    IF next_num IS NULL THEN
        RAISE EXCEPTION 'repository % not found', repo_id;
    END IF;

    RETURN next_num;
END;
$$;

-- Atomic per-repository landing request number allocation
CREATE OR REPLACE FUNCTION get_next_landing_number(repo_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    next_num BIGINT;
BEGIN
    UPDATE repositories
    SET next_landing_number = next_landing_number + 1,
        updated_at = NOW()
    WHERE id = repo_id
    RETURNING next_landing_number - 1 INTO next_num;

    IF next_num IS NULL THEN
        RAISE EXCEPTION 'repository % not found', repo_id;
    END IF;

    RETURN next_num;
END;
$$;

-- Set exactly one default bookmark per repository.
CREATE OR REPLACE FUNCTION set_default_bookmark(p_repo_id BIGINT, p_bookmark_name VARCHAR)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    target_bookmark_id BIGINT;
    cleared_rows BIGINT;
    set_rows BIGINT;
    updated_rows BIGINT;
BEGIN
    SELECT id
    INTO target_bookmark_id
    FROM bookmarks
    WHERE repository_id = p_repo_id
      AND name = p_bookmark_name
    FOR UPDATE;

    IF target_bookmark_id IS NULL THEN
        RAISE EXCEPTION 'bookmark % not found in repository %', p_bookmark_name, p_repo_id;
    END IF;

    UPDATE bookmarks
    SET is_default = FALSE,
        updated_at = NOW()
    WHERE repository_id = p_repo_id
      AND is_default = TRUE
      AND id <> target_bookmark_id;

    GET DIAGNOSTICS cleared_rows = ROW_COUNT;

    UPDATE bookmarks
    SET is_default = TRUE,
        updated_at = NOW()
    WHERE id = target_bookmark_id
      AND is_default = FALSE;

    GET DIAGNOSTICS set_rows = ROW_COUNT;
    updated_rows = cleared_rows + set_rows;

    RETURN updated_rows;
END;
$$;

-- Repository secrets (encrypted at rest)
CREATE TABLE IF NOT EXISTS repository_secrets (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);
CREATE INDEX idx_repository_secrets_repo_id ON repository_secrets (repository_id);

-- Repository variables (plaintext)
CREATE TABLE IF NOT EXISTS repository_variables (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);
CREATE INDEX idx_repository_variables_repo_id ON repository_variables (repository_id);
