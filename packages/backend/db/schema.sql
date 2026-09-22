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
    email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_synthetic    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_users_lower_username ON users (lower_username);
CREATE INDEX idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX uq_users_lower_email ON users (lower_email) WHERE lower_email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_wallet_address ON users (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX idx_users_search_vector_gin ON users USING GIN (search_vector);

-- Closed alpha access control
CREATE TABLE IF NOT EXISTS alpha_whitelist_entries (
    id                   BIGSERIAL PRIMARY KEY,
    identity_type        VARCHAR(16) NOT NULL CHECK (identity_type IN ('email', 'wallet', 'username')),
    identity_value       VARCHAR(255) NOT NULL,
    lower_identity_value VARCHAR(255) NOT NULL,
    created_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identity_type, lower_identity_value)
);

CREATE INDEX idx_alpha_whitelist_created_by ON alpha_whitelist_entries (created_by);

CREATE TABLE IF NOT EXISTS alpha_waitlist_entries (
    id                BIGSERIAL PRIMARY KEY,
    email             VARCHAR(255) NOT NULL,
    lower_email       VARCHAR(255) NOT NULL UNIQUE,
    -- GitHub-backed signup metadata (added for GitHub OAuth waitlist capture).
    -- Both default to '' so the upsert's CASE ... WHEN EXCLUDED.x = '' THEN
    -- keep-existing ... END semantics are well-defined even when the caller
    -- has no GitHub identity on hand. See queries/alpha_access.sql ->
    -- UpsertWaitlistEntry.
    github_username   VARCHAR(255) NOT NULL DEFAULT '',
    github_avatar_url TEXT NOT NULL DEFAULT '',
    note              TEXT NOT NULL DEFAULT '',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    source            VARCHAR(32) NOT NULL DEFAULT 'unknown',
    approved_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    approved_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alpha_waitlist_status_created ON alpha_waitlist_entries (status, created_at DESC);
CREATE INDEX idx_alpha_waitlist_approved_by ON alpha_waitlist_entries (approved_by);

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

-- Canonical cross-type owner namespace. users.lower_username and
-- organizations.lower_name are each unique only within their own table; this
-- table is the single transactional arbiter that keeps one slug from naming
-- both a user and an organization. Claims are maintained by the sync
-- triggers below (INSERT + rename) and released by FK cascade on hard
-- delete. Soft-deleted users keep their claim, matching the existing
-- "usernames are not freed by soft delete" semantics of
-- users.lower_username UNIQUE. Repository lookups resolve the owner through
-- this table before selecting a repository, so a slug always binds to
-- exactly one owner identity/type. Migration 20260718000100 refuses pre-existing
-- collisions rather than silently making one owner's repositories
-- unreachable.
CREATE TABLE IF NOT EXISTS owner_namespaces (
    lower_slug  VARCHAR(255) PRIMARY KEY CHECK (lower_slug = LOWER(lower_slug)),
    owner_type  VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    user_id     BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    org_id      BIGINT UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND org_id IS NULL)
        OR (owner_type = 'org' AND org_id IS NOT NULL AND user_id IS NULL)
    )
);

ALTER TABLE users
    ADD CONSTRAINT ck_users_canonical_owner_namespace
    CHECK (
        lower_username = LOWER(username)
        AND username ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    );

ALTER TABLE organizations
    ADD CONSTRAINT ck_organizations_canonical_owner_namespace
    CHECK (
        lower_name = LOWER(name)
        AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    );

CREATE OR REPLACE FUNCTION sync_user_owner_namespace()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO owner_namespaces (lower_slug, owner_type, user_id)
        VALUES (LOWER(NEW.lower_username), 'user', NEW.id);
    ELSIF NEW.lower_username IS DISTINCT FROM OLD.lower_username THEN
        UPDATE owner_namespaces
        SET lower_slug = LOWER(NEW.lower_username)
        WHERE user_id = NEW.id;
        IF NOT FOUND THEN
            INSERT INTO owner_namespaces (lower_slug, owner_type, user_id)
            VALUES (LOWER(NEW.lower_username), 'user', NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_org_owner_namespace()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO owner_namespaces (lower_slug, owner_type, org_id)
        VALUES (LOWER(NEW.lower_name), 'org', NEW.id);
    ELSIF NEW.lower_name IS DISTINCT FROM OLD.lower_name THEN
        UPDATE owner_namespaces
        SET lower_slug = LOWER(NEW.lower_name)
        WHERE org_id = NEW.id;
        IF NOT FOUND THEN
            INSERT INTO owner_namespaces (lower_slug, owner_type, org_id)
            VALUES (LOWER(NEW.lower_name), 'org', NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Repository storage paths include the exact user/organization name. Freeze
-- both the exact and normalized columns until owner renames can atomically and
-- durably move every repository and sidecar namespace on repo-host.
CREATE OR REPLACE FUNCTION prevent_user_owner_namespace_rename()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.username IS DISTINCT FROM OLD.username
       OR NEW.lower_username IS DISTINCT FROM OLD.lower_username THEN
        RAISE EXCEPTION USING
            ERRCODE = '0A000',
            MESSAGE = 'user owner namespace is immutable',
            HINT = 'Move repository storage with a durable namespace-move workflow before renaming a user.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_org_owner_namespace_rename()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name
       OR NEW.lower_name IS DISTINCT FROM OLD.lower_name THEN
        RAISE EXCEPTION USING
            ERRCODE = '0A000',
            MESSAGE = 'organization owner namespace is immutable',
            HINT = 'Move repository storage with a durable namespace-move workflow before renaming an organization.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_prevent_owner_namespace_rename
    BEFORE UPDATE OF username, lower_username ON users
    FOR EACH ROW EXECUTE FUNCTION prevent_user_owner_namespace_rename();

CREATE TRIGGER trg_organizations_prevent_owner_namespace_rename
    BEFORE UPDATE OF name, lower_name ON organizations
    FOR EACH ROW EXECUTE FUNCTION prevent_org_owner_namespace_rename();

CREATE TRIGGER trg_users_owner_namespace
    AFTER INSERT OR UPDATE OF lower_username ON users
    FOR EACH ROW EXECUTE FUNCTION sync_user_owner_namespace();

CREATE TRIGGER trg_organizations_owner_namespace
    AFTER INSERT OR UPDATE OF lower_name ON organizations
    FOR EACH ROW EXECUTE FUNCTION sync_org_owner_namespace();

-- Authentication sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
    session_key   TEXT PRIMARY KEY,
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
    state_key        VARCHAR(64) PRIMARY KEY,
    context_hash     VARCHAR(64) NOT NULL,
    requested_scopes TEXT[],
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    used_at          TIMESTAMPTZ
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states (expires_at);

-- One-time pending Linear OAuth setup payloads.
CREATE TABLE IF NOT EXISTS linear_oauth_setups (
    setup_key         VARCHAR(64) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload_encrypted BYTEA NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL,
    used_at           TIMESTAMPTZ
);

CREATE INDEX idx_linear_oauth_setups_user_id ON linear_oauth_setups (user_id);
CREATE INDEX idx_linear_oauth_setups_expires_at ON linear_oauth_setups (expires_at);

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
    expires_at        TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_access_tokens_user_id ON access_tokens (user_id);
CREATE INDEX idx_access_tokens_token_hash ON access_tokens (token_hash);
CREATE INDEX idx_access_tokens_expires_at ON access_tokens (expires_at);

-- User AI keys (BYOK — bring your own LLM key)
CREATE TABLE IF NOT EXISTS user_ai_keys (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            VARCHAR(64) NOT NULL,
    api_key_encrypted   TEXT NOT NULL,
    rotated_at          TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_ai_keys_user_id ON user_ai_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_keys_expires_at ON user_ai_keys (expires_at);

-- Repositories
CREATE TABLE IF NOT EXISTS repositories (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT REFERENCES users(id) ON DELETE CASCADE,
    org_id              BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    lower_name          VARCHAR(255) NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    storage_set_id     VARCHAR(50) NOT NULL,
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
    archived_at         TIMESTAMPTZ,
    is_mirror           BOOLEAN NOT NULL DEFAULT FALSE,
    mirror_destination  TEXT NOT NULL DEFAULT '',
    mirror_status       VARCHAR(16) NOT NULL DEFAULT 'unconfigured'
                        CHECK (mirror_status IN ('synced', 'behind', 'failed', 'unconfigured')),
    last_mirror_at      TIMESTAMPTZ,
    last_mirror_error   TEXT,
    last_mirror_github_head VARCHAR(64),
    mirror_behind_refs  INTEGER NOT NULL DEFAULT 0 CHECK (mirror_behind_refs >= 0),
    mirror_failed_refs  INTEGER NOT NULL DEFAULT 0 CHECK (mirror_failed_refs >= 0),
    workspace_idle_timeout_secs INTEGER NOT NULL DEFAULT 1800 CHECK (workspace_idle_timeout_secs > 0),
    workspace_persistence VARCHAR(16) NOT NULL DEFAULT 'persistent'
                      CHECK (workspace_persistence IN ('persistent', 'ephemeral')),
    workspace_dependencies TEXT[] NOT NULL DEFAULT '{}'::text[],
    clone_depth         INTEGER NOT NULL DEFAULT 0 CHECK (clone_depth >= -1),
    landing_queue_mode  VARCHAR(16) NOT NULL DEFAULT 'serialized'
                      CHECK (landing_queue_mode IN ('serialized', 'parallel')),
    landing_queue_required_checks TEXT[] NOT NULL DEFAULT '{}'::text[],
    num_stars           BIGINT NOT NULL DEFAULT 0,
    num_forks           BIGINT NOT NULL DEFAULT 0,
    num_watches         BIGINT NOT NULL DEFAULT 0,
    num_issues          BIGINT NOT NULL DEFAULT 0,
    num_closed_issues   BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(user_id, org_id) = 1),
    CONSTRAINT ck_repositories_canonical_storage_identity CHECK (
        lower_name = LOWER(name)
        AND LENGTH(name) <= 100
        AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
        AND LOWER(name) !~ '\.(git|wiki|docs)$'
        AND LOWER(name) NOT IN (
            'agent', 'bookmarks', 'changes', 'commits', 'contributors',
            'issues', 'labels', 'landings', 'milestones', 'operations',
            'pulls', 'settings', 'stargazers', 'watchers', 'workflows'
        )
    )
);

-- Fork lineage invariant: a row marked is_fork=true should have fork_id
-- populated at creation time. fork_id may later become NULL if the upstream
-- repository is deleted (ON DELETE SET NULL), which is intentional — the fork
-- is orphaned but preserved. The CHECK below fires only at INSERT/UPDATE so it
-- catches logic errors at write time without breaking existing orphaned forks.
-- Invariant: is_fork = TRUE → fork_id IS NOT NULL  (enforced on write only;
-- SET NULL from a parent delete is handled separately by the FK action).
CREATE INDEX idx_repositories_user_id ON repositories (user_id);
CREATE INDEX idx_repositories_org_id ON repositories (org_id);
CREATE INDEX idx_repositories_lower_name ON repositories (lower_name);
CREATE INDEX idx_repositories_topics_gin ON repositories USING GIN (topics);
CREATE INDEX idx_repositories_search_vector_gin ON repositories USING GIN (search_vector);
-- Partial index: quickly find all forks whose upstream is still present.
CREATE INDEX idx_repositories_forks_with_parent
    ON repositories (fork_id)
    WHERE is_fork = TRUE AND fork_id IS NOT NULL;
CREATE UNIQUE INDEX uq_repositories_user_lower_name
    ON repositories (user_id, lower_name)
    WHERE org_id IS NULL;
CREATE UNIQUE INDEX uq_repositories_org_lower_name
    ON repositories (org_id, lower_name)
    WHERE org_id IS NOT NULL;

-- Durable coordination handle for PostgreSQL ownership changes paired with a
-- repo-host staged delete/move. This intentionally has no FK to repositories:
-- a committed delete removes the repository row before the repo-host
-- tombstone can be finalized, so the operation must outlive that row.
CREATE TABLE repository_storage_operations (
    repository_id   BIGINT PRIMARY KEY,
    operation_type  VARCHAR(16) NOT NULL
                    CHECK (operation_type IN ('delete', 'move')),
    token           VARCHAR(64) NOT NULL UNIQUE
                    CHECK (token ~ '^[0-9a-f]{64}$'),
    storage_set_id  TEXT NOT NULL,
    source_owner    VARCHAR(255) NOT NULL CHECK (BTRIM(source_owner) <> ''),
    source_repo     VARCHAR(255) NOT NULL CHECK (BTRIM(source_repo) <> ''),
    source_user_id  BIGINT,
    source_org_id   BIGINT,
    target_owner    VARCHAR(255),
    target_repo     VARCHAR(255),
    target_user_id  BIGINT,
    target_org_id   BIGINT,
    claim_token     VARCHAR(64),
    claimed_at      TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(source_user_id, source_org_id) = 1),
    CHECK (
        (operation_type = 'delete'
         AND target_owner IS NULL
         AND target_repo IS NULL
         AND target_user_id IS NULL
         AND target_org_id IS NULL)
        OR
        (operation_type = 'move'
         AND target_owner IS NOT NULL
         AND target_repo IS NOT NULL
         AND BTRIM(target_owner) <> ''
         AND BTRIM(target_repo) <> ''
         AND num_nonnulls(target_user_id, target_org_id) = 1)
    ),
    CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE INDEX idx_repository_storage_operations_reconcile
    ON repository_storage_operations (created_at, claimed_at, repository_id);

-- Expand/contract switch shared by rolling-upgrade-sensitive mutation
-- protocols. The deploy drain gate moves both booleans to true together.
CREATE TABLE legacy_mutation_fence_control (
    singleton                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enforce_repository_storage BOOLEAN NOT NULL DEFAULT FALSE,
    enforce_release_deletion   BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO legacy_mutation_fence_control (
    singleton, enforce_repository_storage, enforce_release_deletion
) VALUES (TRUE, FALSE, FALSE);

CREATE OR REPLACE FUNCTION fence_repository_storage_operation()
RETURNS TRIGGER AS $$
DECLARE
	v_operation repository_storage_operations%ROWTYPE;
	v_authorized_token TEXT := NULLIF(
		current_setting('smithers.repository_storage_operation_token', TRUE),
		''
	);
	v_has_operation BOOLEAN;
	v_identity_changed BOOLEAN;
	v_enforce_repository_storage BOOLEAN;
BEGIN
	SELECT enforce_repository_storage
	INTO STRICT v_enforce_repository_storage
	FROM legacy_mutation_fence_control
	WHERE singleton;

	SELECT * INTO v_operation
	FROM repository_storage_operations
	WHERE repository_id = OLD.id;
	v_has_operation := FOUND;

	IF TG_OP = 'DELETE' THEN
		IF NOT v_has_operation AND NOT v_enforce_repository_storage THEN
			RETURN OLD;
		END IF;
		IF NOT v_has_operation
		   OR v_operation.operation_type <> 'delete'
		   OR v_operation.token IS DISTINCT FROM v_authorized_token
		   OR OLD.user_id IS DISTINCT FROM v_operation.source_user_id
		   OR OLD.org_id IS DISTINCT FROM v_operation.source_org_id
		   OR OLD.name IS DISTINCT FROM v_operation.source_repo
		   OR OLD.lower_name IS DISTINCT FROM LOWER(v_operation.source_repo) THEN
			RAISE EXCEPTION USING
				ERRCODE = '55006',
				MESSAGE = 'repository deletion requires an authorized durable storage operation',
				DETAIL = FORMAT('Repository %s cannot be deleted without its matching repo-host journal.', OLD.id),
				HINT = 'Delete the repository through the durable repository service.';
		END IF;
		RETURN OLD;
	END IF;

	v_identity_changed :=
		NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.org_id IS DISTINCT FROM OLD.org_id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
		OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id;

	IF NEW.name IS DISTINCT FROM OLD.name
	   OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
	   OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id THEN
		RAISE EXCEPTION USING
			ERRCODE = '0A000',
			MESSAGE = 'repository storage namespace and placement are immutable',
			HINT = 'Use a durable repository rename or storage migration workflow before changing these fields.';
	END IF;

	IF v_identity_changed THEN
		IF NOT v_has_operation AND NOT v_enforce_repository_storage THEN
			RETURN NEW;
		END IF;
		IF NOT v_has_operation
		   OR v_operation.operation_type <> 'move'
		   OR v_operation.token IS DISTINCT FROM v_authorized_token
		   OR OLD.user_id IS DISTINCT FROM v_operation.source_user_id
		   OR OLD.org_id IS DISTINCT FROM v_operation.source_org_id
		   OR OLD.name IS DISTINCT FROM v_operation.source_repo
		   OR OLD.lower_name IS DISTINCT FROM LOWER(v_operation.source_repo)
		   OR NEW.user_id IS DISTINCT FROM v_operation.target_user_id
		   OR NEW.org_id IS DISTINCT FROM v_operation.target_org_id
		   OR NEW.name IS DISTINCT FROM v_operation.target_repo
		   OR NEW.lower_name IS DISTINCT FROM LOWER(v_operation.target_repo) THEN
			RAISE EXCEPTION USING
				ERRCODE = '55006',
				MESSAGE = 'repository ownership change requires an authorized durable storage operation',
				DETAIL = FORMAT('Repository %s ownership cannot change without its matching repo-host journal.', OLD.id),
				HINT = 'Transfer the repository through the durable repository service.';
		END IF;
		RETURN NEW;
	END IF;

	IF v_has_operation THEN
		RAISE EXCEPTION USING
			ERRCODE = '55006',
			MESSAGE = 'repository storage operation is already in progress',
			DETAIL = FORMAT('Repository %s has an unresolved repo-host storage journal.', OLD.id),
			HINT = 'Wait for the durable repository storage reconciler to complete the existing operation.';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_storage_operation
    BEFORE UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_storage_operation();

-- Owner FK cascades cannot coordinate repository bytes on repo-host. Require
-- every owned repository to be durably deleted or transferred first.
CREATE OR REPLACE FUNCTION prevent_owner_delete_with_repositories()
RETURNS TRIGGER AS $$
DECLARE
    v_enforce_repository_storage BOOLEAN;
BEGIN
    SELECT enforce_repository_storage
    INTO STRICT v_enforce_repository_storage
    FROM legacy_mutation_fence_control
    WHERE singleton;

    IF NOT v_enforce_repository_storage THEN
        RETURN OLD;
    END IF;

    IF TG_TABLE_NAME = 'users' AND EXISTS (
        SELECT 1 FROM repositories WHERE user_id = OLD.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete user while repositories still exist',
            HINT = 'Delete or transfer every repository through the durable repository workflow first.';
    ELSIF TG_TABLE_NAME = 'organizations' AND EXISTS (
        SELECT 1 FROM repositories WHERE org_id = OLD.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete organization while repositories still exist',
            HINT = 'Delete or transfer every repository through the durable repository workflow first.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_prevent_repository_cascade
    BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION prevent_owner_delete_with_repositories();

CREATE TRIGGER trg_organizations_prevent_repository_cascade
    BEFORE DELETE ON organizations
    FOR EACH ROW EXECUTE FUNCTION prevent_owner_delete_with_repositories();

-- Denormalized fork counter maintenance. num_forks is kept in sync by the
-- database itself so every fork-creation and fork-deletion path (including
-- FK cascade deletes, e.g. a user deletion cascading away their forks) is
-- counted exactly once. Application code must NOT also adjust num_forks.
CREATE OR REPLACE FUNCTION maintain_repo_fork_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_forks = num_forks + 1,
            updated_at = NOW()
        WHERE id = NEW.fork_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_forks = GREATEST(num_forks - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.fork_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fork_count_inc
    AFTER INSERT ON repositories
    FOR EACH ROW
    WHEN (NEW.fork_id IS NOT NULL)
    EXECUTE FUNCTION maintain_repo_fork_count();

CREATE TRIGGER trg_repositories_fork_count_dec
    AFTER DELETE ON repositories
    FOR EACH ROW
    WHEN (OLD.fork_id IS NOT NULL)
    EXECUTE FUNCTION maintain_repo_fork_count();

-- Repository storage sets and live replica state.
-- A storage set is the logical placement target for a repository. Individual
-- repo-host nodes inside the set hold full local-disk replicas.
CREATE TABLE IF NOT EXISTS repo_storage_sets (
    id               TEXT PRIMARY KEY,
    desired_replicas INTEGER NOT NULL DEFAULT 3 CHECK (desired_replicas > 0),
    write_quorum     INTEGER NOT NULL DEFAULT 2 CHECK (write_quorum > 0),
    state            VARCHAR(16) NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active', 'draining', 'disabled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (write_quorum <= desired_replicas)
);

CREATE TABLE IF NOT EXISTS repo_storage_nodes (
    id             TEXT PRIMARY KEY,
    storage_set_id TEXT NOT NULL REFERENCES repo_storage_sets(id) ON DELETE CASCADE,
    url            TEXT NOT NULL,
    zone           TEXT NOT NULL DEFAULT '',
    state          VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'draining', 'offline')),
    last_seen_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (storage_set_id, url)
);

CREATE INDEX idx_repo_storage_nodes_storage_set
    ON repo_storage_nodes (storage_set_id, state);

-- Bootstrap the default storage set so a fresh install can create
-- repositories immediately (services.DefaultStorageSetID = 's1'). seed.sql
-- upgrades this row with real replica/quorum settings where applicable.
INSERT INTO repo_storage_sets (id) VALUES ('s1')
ON CONFLICT (id) DO NOTHING;

-- Every repository must point at an existing storage set; a typo'd or deleted
-- storage-set id must be rejected at write time rather than surfacing later as
-- an unresolvable placement during repo-host storage resolution.
ALTER TABLE repositories
    ADD CONSTRAINT fk_repositories_storage_set
    FOREIGN KEY (storage_set_id) REFERENCES repo_storage_sets(id)
    ON DELETE RESTRICT;

ALTER TABLE repository_storage_operations
    ADD CONSTRAINT fk_repository_storage_operations_storage_set
    FOREIGN KEY (storage_set_id) REFERENCES repo_storage_sets(id)
    ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS repo_replicas (
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_id         TEXT NOT NULL REFERENCES repo_storage_nodes(id) ON DELETE CASCADE,
    generation      BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    state_hash      TEXT NOT NULL DEFAULT '',
    state           VARCHAR(16) NOT NULL DEFAULT 'stale'
                    CHECK (state IN ('current', 'stale', 'repairing', 'missing')),
    last_verified_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, node_id)
);

CREATE INDEX idx_repo_replicas_repository_state
    ON repo_replicas (repository_id, state, generation DESC);
CREATE INDEX idx_repo_replicas_node_state
    ON repo_replicas (node_id, state);

CREATE TABLE IF NOT EXISTS repo_write_locks (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    generation    BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    locked_by     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repo_write_locks_expires_at
    ON repo_write_locks (expires_at);

CREATE TABLE IF NOT EXISTS repo_replication_jobs (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_node_id TEXT REFERENCES repo_storage_nodes(id) ON DELETE SET NULL,
    target_node_id TEXT NOT NULL REFERENCES repo_storage_nodes(id) ON DELETE CASCADE,
    generation     BIGINT NOT NULL CHECK (generation >= 0),
    state          VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
    attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error          TEXT NOT NULL DEFAULT '',
    run_after      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repo_replication_jobs_claim
    ON repo_replication_jobs (state, run_after, id);
CREATE INDEX idx_repo_replication_jobs_repository
    ON repo_replication_jobs (repository_id, generation DESC);

-- Deploy keys (per-repository SSH keys)
CREATE TABLE IF NOT EXISTS deploy_keys (
    id               BIGSERIAL PRIMARY KEY,
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    key_fingerprint  TEXT NOT NULL,
    public_key       TEXT NOT NULL,
    read_only        BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, key_fingerprint)
);

CREATE INDEX idx_deploy_keys_repo_id ON deploy_keys (repository_id);
CREATE INDEX idx_deploy_keys_fingerprint ON deploy_keys (key_fingerprint);


-- Git LFS objects
CREATE TABLE IF NOT EXISTS lfs_objects (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid             TEXT NOT NULL,
    size            BIGINT NOT NULL,
    gcs_path        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX idx_lfs_objects_repo ON lfs_objects (repository_id);

-- Quota reservations for staged Git LFS uploads. Expired rows remain billable
-- until cleanup confirms their staged bytes were deleted.
CREATE TABLE IF NOT EXISTS lfs_upload_reservations (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid             TEXT NOT NULL,
    size            BIGINT NOT NULL CHECK (size >= 0),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX idx_lfs_upload_reservations_repo ON lfs_upload_reservations (repository_id);
CREATE INDEX idx_lfs_upload_reservations_expiry ON lfs_upload_reservations (expires_at);

-- Fail-closed rollout control for upload capabilities issued by legacy
-- signers that accepted arbitrary lifetimes and wrote directly to final keys.
-- Operators replace infinity with an evidenced absolute horizon only after
-- every legacy signer has drained.
CREATE TABLE IF NOT EXISTS storage_legacy_capability_horizons (
    capability_kind VARCHAR(64) PRIMARY KEY,
    valid_until     TIMESTAMPTZ NOT NULL,
    attested_at     TIMESTAMPTZ,
    attested_by     TEXT,
    attestation     TEXT,
    CONSTRAINT storage_legacy_capability_horizons_attestation_check CHECK (
        (
            valid_until = 'infinity'::timestamptz
            AND attested_at IS NULL
            AND attested_by IS NULL
            AND attestation IS NULL
        )
        OR
        (
            isfinite(valid_until)
            AND attested_at IS NOT NULL
            AND BTRIM(COALESCE(attested_by, '')) <> ''
            AND BTRIM(COALESCE(attestation, '')) <> ''
        )
    )
);

INSERT INTO storage_legacy_capability_horizons (
    capability_kind, valid_until
) VALUES (
    'legacy-final-key-upload', 'infinity'::timestamptz
)
ON CONFLICT (capability_kind) DO NOTHING;

-- Durable exact-key tombstones for object-store cleanup. repository_id and
-- owner identity are intentionally denormalized without foreign keys because
-- rows must survive repository/user/organization deletion until every live and
-- archived object generation is physically gone.
CREATE TABLE IF NOT EXISTS storage_deletion_queue (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    owner_type       VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id         BIGINT NOT NULL,
    allocation_key  TEXT NOT NULL CHECK (BTRIM(allocation_key) <> ''),
    object_key      TEXT NOT NULL UNIQUE CHECK (BTRIM(object_key) <> ''),
    size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
    delete_after    TIMESTAMPTZ NOT NULL,
    -- NULL denotes a staging key. Final keys retain their metadata-specific
    -- deadline here while delete_after uses a far-future finite sentinel for
    -- old queue workers and Go time.Time compatibility.
    requested_delete_after TIMESTAMPTZ,
    claim_token     VARCHAR(64),
    claimed_at      TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT storage_deletion_queue_claim_state_check CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE INDEX idx_storage_deletion_queue_due
    ON storage_deletion_queue (delete_after, claimed_at, id);
CREATE INDEX idx_storage_deletion_queue_owner
    ON storage_deletion_queue (owner_type, owner_id, allocation_key);
CREATE INDEX idx_storage_deletion_queue_repository
    ON storage_deletion_queue (repository_id, allocation_key);

-- Git LFS locks
CREATE TABLE IF NOT EXISTS lfs_locks (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path            VARCHAR(2048) NOT NULL,
    owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, path)
);

CREATE INDEX idx_lfs_locks_repo ON lfs_locks (repository_id);
CREATE INDEX idx_lfs_locks_owner ON lfs_locks (owner_id);

-- Git LFS metadata
CREATE TABLE IF NOT EXISTS lfs_meta_objects (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid            VARCHAR(255) NOT NULL,
    size           BIGINT NOT NULL CHECK (size >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX idx_lfs_meta_objects_repository_id ON lfs_meta_objects (repository_id);
CREATE INDEX idx_lfs_meta_objects_oid ON lfs_meta_objects (oid);
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

-- collaborators.user_id uses ON DELETE SET NULL so that the collaboration
-- record (including the permission level) survives user deletion as a
-- historical audit trail. A partial unique index enforces the active
-- one-row-per-(repo, user) constraint while allowing NULL tombstones.
CREATE TABLE IF NOT EXISTS collaborators (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    permission     VARCHAR(16) NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active collaborator rows are unique per (repo, user); tombstones
-- (user_id IS NULL) are not subject to uniqueness enforcement.
CREATE UNIQUE INDEX uq_collaborators_repo_user
    ON collaborators (repository_id, user_id)
    WHERE user_id IS NOT NULL;

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
    state          VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'fixed', 'verified')),
    author_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    milestone_id   BIGINT REFERENCES milestones(id) ON DELETE SET NULL,
    comment_count  BIGINT NOT NULL DEFAULT 0,
    closed_at      TIMESTAMPTZ,
    fixed_by_id    BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    fixed_by_agent_session_id UUID,
    fixed_at       TIMESTAMPTZ,
    verified_by_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    verified_by_agent_session_id UUID,
    verified_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, number),
    UNIQUE (repository_id, id),
    CONSTRAINT issues_fix_metadata_check CHECK (
        (state IN ('fixed', 'verified') AND fixed_by_id IS NOT NULL AND fixed_at IS NOT NULL)
        OR (state NOT IN ('fixed', 'verified') AND fixed_by_id IS NULL
            AND fixed_by_agent_session_id IS NULL AND fixed_at IS NULL)
    ),
    CONSTRAINT issues_verification_metadata_check CHECK (
        (state = 'verified' AND verified_by_id IS NOT NULL AND verified_at IS NOT NULL)
        OR (state <> 'verified' AND verified_by_id IS NULL
            AND verified_by_agent_session_id IS NULL AND verified_at IS NULL)
    ),
    CONSTRAINT issues_distinct_verifier_check CHECK (
        state <> 'verified'
        OR (
            fixed_by_agent_session_id IS NOT NULL
            AND (verified_by_agent_session_id IS NULL
                 OR verified_by_agent_session_id <> fixed_by_agent_session_id)
        )
        OR (
            fixed_by_agent_session_id IS NULL
            AND (verified_by_agent_session_id IS NOT NULL
                 OR verified_by_id <> fixed_by_id)
        )
    )
);

CREATE INDEX idx_issues_repo_state ON issues (repository_id, state, number DESC);
CREATE INDEX idx_issues_open_partial ON issues (repository_id, number DESC) WHERE state = 'open';
CREATE INDEX idx_issues_search_vector_gin ON issues USING GIN (search_vector);

-- Denormalized issue counter maintenance. repositories.num_issues and
-- num_closed_issues are kept in sync by the database itself so concurrent
-- state changes (e.g. two racing PATCHes closing the same issue) are counted
-- exactly once — the trigger only fires when the row actually transitions.
-- Application code must NOT also adjust these counters.
CREATE OR REPLACE FUNCTION maintain_repo_issue_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_issues = num_issues + 1,
            num_closed_issues = num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        UPDATE repositories
        SET num_closed_issues = GREATEST(
                num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END
                - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END,
                0),
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_issues = GREATEST(num_issues - 1, 0),
        num_closed_issues = GREATEST(num_closed_issues
            - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_repo_counts_ins
    AFTER INSERT ON issues
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE TRIGGER trg_issues_repo_counts_upd
    AFTER UPDATE ON issues
    FOR EACH ROW
    WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE TRIGGER trg_issues_repo_counts_del
    AFTER DELETE ON issues
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE TABLE IF NOT EXISTS issue_comments (
    id            BIGSERIAL PRIMARY KEY,
    issue_id       BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    commenter      VARCHAR(255) NOT NULL DEFAULT '',
    body           TEXT NOT NULL,
    type           VARCHAR(32) NOT NULL DEFAULT 'comment',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_issue_comments_issue_id ON issue_comments (issue_id, created_at);

-- Denormalized comment counter maintenance. issues.comment_count is kept in
-- sync by the database itself so a comment insert/delete is counted exactly
-- once even under concurrent deletes of the same comment (the delete trigger
-- only fires for a row that was actually removed). Application code must NOT
-- also adjust comment_count.
CREATE OR REPLACE FUNCTION maintain_issue_comment_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE issues
        SET comment_count = comment_count + 1,
            updated_at = NOW()
        WHERE id = NEW.issue_id;
        RETURN NEW;
    END IF;
    UPDATE issues
    SET comment_count = GREATEST(comment_count - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.issue_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issue_comments_count_ins
    AFTER INSERT ON issue_comments
    FOR EACH ROW
    EXECUTE FUNCTION maintain_issue_comment_count();

CREATE TRIGGER trg_issue_comments_count_del
    AFTER DELETE ON issue_comments
    FOR EACH ROW
    EXECUTE FUNCTION maintain_issue_comment_count();

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

-- issue_assignees uses a surrogate PK so that user_id can be nullable.
-- ON DELETE SET NULL preserves the assignment history row when an assignee
-- account is deleted; the row becomes a tombstone (user_id IS NULL) that
-- records the assignment ever existed. Active assignments are deduplicated
-- by the partial unique index below.
CREATE TABLE IF NOT EXISTS issue_assignees (
    id           BIGSERIAL PRIMARY KEY,
    issue_id     BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce one active assignment per (issue, user) while allowing multiple
-- tombstone rows (user_id IS NULL) to coexist.
CREATE UNIQUE INDEX uq_issue_assignees_issue_user
    ON issue_assignees (issue_id, user_id)
    WHERE user_id IS NOT NULL;

-- Accepted issue rows and membership rows, distinct from the presentation timeline.
CREATE TABLE issue_state_journals (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    head BIGINT NOT NULL DEFAULT 0 CHECK (head >= 0),
    coverage_kind TEXT NOT NULL DEFAULT 'from_creation' CHECK (coverage_kind IN ('legacy_snapshot', 'from_creation')),
    coverage_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE issue_state_facts (
    repository_id BIGINT NOT NULL REFERENCES issue_state_journals(repository_id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('issue', 'issue_label', 'issue_assignee')),
    operation TEXT NOT NULL CHECK (operation IN ('baseline', 'created', 'updated', 'deleted')),
    issue_id BIGINT NOT NULL,
    entity_key TEXT NOT NULL,
    post_image JSONB CHECK (post_image IS NULL OR jsonb_typeof(post_image) = 'object'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (repository_id, sequence),
    CHECK ((operation = 'deleted' AND post_image IS NULL) OR (operation <> 'deleted' AND post_image IS NOT NULL))
);
CREATE INDEX idx_issue_state_facts_issue ON issue_state_facts (repository_id, issue_id, sequence);

CREATE OR REPLACE FUNCTION lock_issue_state_journal()
RETURNS TRIGGER AS $$
DECLARE repo BIGINT; parent_issue BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'issues' THEN
        IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.repository_id <> OLD.repository_id OR NEW.number <> OLD.number) THEN
            RAISE EXCEPTION 'issue identity is immutable' USING ERRCODE = '23514';
        END IF;
        repo := CASE WHEN TG_OP = 'DELETE' THEN OLD.repository_id ELSE NEW.repository_id END;
    ELSE
        IF TG_OP = 'UPDATE' AND NEW.issue_id <> OLD.issue_id THEN
            RAISE EXCEPTION 'issue membership parent is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF TG_TABLE_NAME = 'issue_assignees' THEN
                IF NEW.id <> OLD.id THEN
                    RAISE EXCEPTION 'issue assignment identity is immutable' USING ERRCODE = '23514';
                END IF;
            ELSE
                IF NEW.label_id <> OLD.label_id THEN
                    RAISE EXCEPTION 'issue label identity is immutable' USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
        parent_issue := CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
        SELECT repository_id INTO repo FROM issues WHERE id = parent_issue;
    END IF;
    -- Match issue-number allocation and repository issue-count triggers. The
    -- journal counter is allocated only after both locks have been acquired.
    PERFORM id FROM repositories WHERE id = repo FOR UPDATE;
    IF FOUND THEN
        INSERT INTO issue_state_journals(repository_id) VALUES(repo) ON CONFLICT DO NOTHING;
        PERFORM repository_id FROM issue_state_journals WHERE repository_id = repo FOR UPDATE;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_issue_state_fact()
RETURNS TRIGGER AS $$
DECLARE repo BIGINT; parent_issue BIGINT; position BIGINT; entity TEXT; identity TEXT; image JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    image := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_TABLE_NAME = 'issues' THEN
        repo := (image ->> 'repository_id')::BIGINT;
        parent_issue := (image ->> 'id')::BIGINT;
        entity := 'issue'; identity := parent_issue::TEXT;
        image := image - 'search_vector';
        IF TG_OP = 'UPDATE' AND image = to_jsonb(OLD) - 'search_vector' THEN RETURN NEW; END IF;
    ELSE
        parent_issue := (image ->> 'issue_id')::BIGINT;
        SELECT repository_id INTO repo FROM issues WHERE id = parent_issue;
        IF TG_TABLE_NAME = 'issue_labels' THEN
            entity := 'issue_label'; identity := parent_issue::TEXT || ':' || (image ->> 'label_id');
        ELSE
            entity := 'issue_assignee'; identity := image ->> 'id';
        END IF;
    END IF;
    -- An issue delete fact removes all its memberships during projection.
    -- Cascading child deletion sees no issue; repository deletion purges its
    -- complete private history instead of appending an orphan tombstone.
    IF repo IS NULL OR NOT EXISTS (SELECT 1 FROM repositories WHERE id = repo) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    UPDATE issue_state_journals SET head = head + 1 WHERE repository_id = repo RETURNING head INTO STRICT position;
    INSERT INTO issue_state_facts(repository_id, sequence, entity_type, operation, issue_id, entity_key, post_image)
    VALUES(repo, position, entity, CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        parent_issue, identity, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE image END);
    PERFORM pg_notify('issue_state_facts_' || repo::TEXT, position::TEXT);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_issue_state_fact_history()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM repositories WHERE id = OLD.repository_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'issue state facts are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issues_record_fact AFTER INSERT OR UPDATE OR DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_labels_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issue_labels
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issue_labels_record_fact AFTER INSERT OR UPDATE OR DELETE ON issue_labels
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_assignees_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issue_assignees
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issue_assignees_record_fact AFTER INSERT OR UPDATE OR DELETE ON issue_assignees
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_state_facts_immutable BEFORE UPDATE OR DELETE ON issue_state_facts
    FOR EACH ROW EXECUTE FUNCTION guard_issue_state_fact_history();

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
    request_id       UUID,
    create_request_hash BYTEA,
    title            VARCHAR(255) NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    state            VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'merged', 'draft', 'queued', 'landing', 'failed')),
    author_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_bookmark  VARCHAR(255) NOT NULL,
    source_bookmark  VARCHAR(255) NOT NULL DEFAULT '',
    conflict_status  VARCHAR(16) NOT NULL DEFAULT 'unknown' CHECK (conflict_status IN ('clean', 'conflicted', 'unknown')),
    stack_size       BIGINT NOT NULL DEFAULT 0,
    agent_authored   BOOLEAN NOT NULL DEFAULT FALSE,
    author_agent_session_id UUID,
    turn_party       VARCHAR(16) NOT NULL DEFAULT 'reviewer' CHECK (turn_party IN ('author', 'reviewer')),
    turn_actor_id    TEXT NOT NULL DEFAULT '',
    turn_since       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    turn_reason      VARCHAR(16) NOT NULL DEFAULT 'request' CHECK (turn_reason IN ('comment', 'revision', 'request')),
    turn_revision_id BIGINT NOT NULL DEFAULT 0,
    landed_revisions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(landed_revisions) = 'object'),
    auto_land_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    auto_land_set_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    auto_land_set_at TIMESTAMPTZ,
    auto_land_checked_at TIMESTAMPTZ,
    queued_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    queued_at        TIMESTAMPTZ,
    landing_started_at TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,
    merged_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT landing_requests_auto_land_intent_check CHECK (
        (auto_land_enabled AND auto_land_set_by IS NOT NULL AND auto_land_set_at IS NOT NULL)
        OR
        (NOT auto_land_enabled AND auto_land_set_by IS NULL AND auto_land_set_at IS NULL)
    ),
    CONSTRAINT landing_requests_create_identity CHECK (
        (request_id IS NULL AND create_request_hash IS NULL) OR
        (request_id IS NOT NULL AND create_request_hash IS NOT NULL AND octet_length(create_request_hash) = 32)
    ),
    UNIQUE (repository_id, author_id, request_id),
    UNIQUE (repository_id, number)
);

CREATE INDEX idx_landing_requests_repo_state ON landing_requests (repository_id, state, number DESC);
CREATE INDEX idx_landing_requests_open_partial ON landing_requests (repository_id, number DESC) WHERE state = 'open';
CREATE INDEX idx_landing_requests_author_agent_session
    ON landing_requests (author_agent_session_id) WHERE author_agent_session_id IS NOT NULL;
CREATE INDEX idx_landing_requests_auto_land ON landing_requests (auto_land_checked_at ASC NULLS FIRST, auto_land_set_at ASC, id ASC) WHERE auto_land_enabled AND state = 'open';

CREATE FUNCTION protect_landing_create_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id OR
       NEW.create_request_hash IS DISTINCT FROM OLD.create_request_hash OR
       (OLD.request_id IS NOT NULL AND (NEW.author_id <> OLD.author_id OR NEW.repository_id <> OLD.repository_id)) THEN
        RAISE EXCEPTION 'landing create identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER landing_create_identity_immutable BEFORE UPDATE ON landing_requests
FOR EACH ROW EXECUTE FUNCTION protect_landing_create_identity();

CREATE TABLE IF NOT EXISTS landing_tasks (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'append_pending', 'running', 'done', 'failed')),
    priority           SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
    attempt            INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    append_request     JSONB,
    CONSTRAINT landing_tasks_append_dispatch CHECK (
        (append_request IS NULL AND status <> 'append_pending') OR
        (append_request IS NOT NULL AND jsonb_typeof(append_request) = 'object' AND status <> 'pending')
    ),
    UNIQUE (landing_request_id)
);

CREATE INDEX idx_landing_tasks_status_priority ON landing_tasks (status, priority DESC, created_at ASC) WHERE status IN ('pending', 'append_pending');
CREATE INDEX idx_landing_tasks_repo_running ON landing_tasks (repository_id) WHERE status = 'running';

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
CREATE INDEX idx_landing_request_changes_change ON landing_request_changes (change_id, landing_request_id);

CREATE TABLE IF NOT EXISTS landing_review_requests (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    requested_by       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reviewer_id        BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    agent_name         VARCHAR(255),
    state              VARCHAR(16) NOT NULL DEFAULT 'requested'
                       CHECK (state IN ('requested', 'fulfilled', 'dismissed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT landing_review_requests_principal_check CHECK (
        (reviewer_id IS NOT NULL AND agent_name IS NULL)
        OR
        (reviewer_id IS NULL AND agent_name IS NOT NULL AND length(btrim(agent_name)) > 0)
    )
);

CREATE INDEX idx_landing_review_requests_landing
    ON landing_review_requests (landing_request_id, created_at, id);

CREATE UNIQUE INDEX uq_landing_review_requests_requested_reviewer
    ON landing_review_requests (landing_request_id, reviewer_id)
    WHERE state = 'requested' AND reviewer_id IS NOT NULL;

CREATE UNIQUE INDEX uq_landing_review_requests_requested_agent
    ON landing_review_requests (landing_request_id, lower(agent_name))
    WHERE state = 'requested' AND agent_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS landing_request_reviews (
    id                  BIGSERIAL PRIMARY KEY,
    landing_request_id  BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    reviewer_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewer_kind       VARCHAR(16) NOT NULL DEFAULT 'human' CHECK (reviewer_kind IN ('human', 'agent')),
    agent_session_id    UUID,
    type                VARCHAR(32) NOT NULL CHECK (type IN ('pending', 'approve', 'comment', 'request_changes')),
    verdict             VARCHAR(16) CHECK (verdict IN ('lgtm', 'concerns')),
    confidence_bucket   VARCHAR(16) CHECK (confidence_bucket IN ('high', 'medium', 'low')),
    summary             TEXT NOT NULL DEFAULT '',
    body                TEXT NOT NULL DEFAULT '',
    state               VARCHAR(32) NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'dismissed')),
    commit_id           VARCHAR(255) NOT NULL DEFAULT '',
    change_revisions    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(change_revisions) = 'object'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT landing_request_reviews_principal_check CHECK (
        (reviewer_kind = 'human' AND agent_session_id IS NULL)
        OR reviewer_kind = 'agent'
    ),
    CONSTRAINT landing_request_reviews_agent_fields_check CHECK (
        reviewer_kind = 'human'
        OR (
            verdict IS NOT NULL
            AND confidence_bucket IS NOT NULL
            AND length(btrim(summary)) > 0
            AND length(btrim(commit_id)) > 0
        )
    )
);

CREATE INDEX idx_landing_request_reviews_lr_id ON landing_request_reviews (landing_request_id, created_at);
CREATE INDEX idx_landing_request_reviews_agent_session
    ON landing_request_reviews (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX idx_landing_request_reviews_agent_lgtm
    ON landing_request_reviews (landing_request_id, commit_id)
    WHERE reviewer_kind = 'agent' AND verdict = 'lgtm' AND state = 'submitted';

CREATE TABLE IF NOT EXISTS landing_request_comments (
    id                BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    user_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    path              TEXT NOT NULL DEFAULT '',
    line              BIGINT NOT NULL DEFAULT 0,
    side              VARCHAR(8) NOT NULL DEFAULT 'right' CHECK (side IN ('left', 'right', 'both')),
    body              TEXT NOT NULL,
    commit_id         VARCHAR(255) NOT NULL DEFAULT '',
    anchor_hash       VARCHAR(64) NOT NULL DEFAULT '',
    state             VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'resolved')),
    done_at           TIMESTAMPTZ,
    done_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    resolved_in_revision JSONB NOT NULL DEFAULT 'null'::jsonb CHECK (resolved_in_revision = 'null'::jsonb OR jsonb_typeof(resolved_in_revision) = 'object'),
    resolved_at       TIMESTAMPTZ,
    resolved_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_landing_request_comments_lr_id ON landing_request_comments (landing_request_id, created_at);
CREATE INDEX idx_landing_request_comments_unresolved ON landing_request_comments (landing_request_id, id) WHERE state <> 'resolved';

-- Stacked change submission state (user's stacked PR / landing-request submit run)
CREATE TABLE IF NOT EXISTS stacks (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_ref      VARCHAR(255) NOT NULL DEFAULT 'main',
    state           VARCHAR(32) NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'landed', 'unsubmitted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, user_id, target_ref, state)
);

CREATE INDEX IF NOT EXISTS idx_stacks_repository_state ON stacks (repository_id, state);

CREATE TABLE IF NOT EXISTS stack_changes (
    id              BIGSERIAL PRIMARY KEY,
    stack_id        BIGINT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    change_id       VARCHAR(255) NOT NULL,
    position        INTEGER NOT NULL,
    branch_name     VARCHAR(255) NOT NULL,
    pr_number       BIGINT,
    pr_state        VARCHAR(32),
    review_status   VARCHAR(32),
    ci_status       VARCHAR(32),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Deferred so a single-statement bulk upsert can reorder existing rows
    -- (e.g. swap two positions); the constraint is checked once the whole
    -- statement has applied instead of per-row.
    CONSTRAINT uq_stack_changes_stack_position UNIQUE (stack_id, position) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (stack_id, change_id)
);

CREATE INDEX IF NOT EXISTS idx_stack_changes_stack_id ON stack_changes (stack_id);

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
    revision_seq       BIGINT NOT NULL DEFAULT 1 CHECK (revision_seq > 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, change_id)
);

CREATE INDEX idx_changes_repo_id_desc ON changes (repository_id, id DESC);
CREATE INDEX idx_changes_parent_change_ids_gin ON changes USING GIN (parent_change_ids);

CREATE TABLE IF NOT EXISTS change_revisions (
    id                    BIGSERIAL PRIMARY KEY,
    repository_id         BIGINT NOT NULL,
    change_id             VARCHAR(255) NOT NULL,
    seq                   BIGINT NOT NULL CHECK (seq > 0),
    commit_id             VARCHAR(255) NOT NULL,
    parent_commit_id      VARCHAR(255) NOT NULL DEFAULT '',
    source                VARCHAR(16) NOT NULL CHECK (source IN ('push', 'rebase', 'agent', 'undo', 'revert', 'split')),
    agent_session_id      UUID,
    workspace_snapshot_id UUID,
    workspace_id          UUID,
    operation_ids         TEXT[] NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (repository_id, change_id)
        REFERENCES changes(repository_id, change_id) ON DELETE CASCADE,
    UNIQUE (repository_id, change_id, seq)
);

CREATE INDEX idx_change_revisions_change_seq
    ON change_revisions (repository_id, change_id, seq DESC);
CREATE UNIQUE INDEX idx_change_revisions_non_undo_commit
    ON change_revisions (repository_id, change_id, commit_id)
    WHERE source <> 'undo';
CREATE INDEX idx_change_revisions_agent_session
    ON change_revisions (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX idx_change_revisions_workspace_snapshot
    ON change_revisions (workspace_snapshot_id) WHERE workspace_snapshot_id IS NOT NULL;
CREATE INDEX idx_change_revisions_workspace
    ON change_revisions (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS issue_change_links (
    repository_id BIGINT NOT NULL,
    issue_id       BIGINT NOT NULL,
    change_id      VARCHAR(255) NOT NULL,
    link_type      VARCHAR(16) NOT NULL CHECK (link_type IN ('issue', 'closes')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, issue_id, change_id),
    FOREIGN KEY (repository_id, issue_id)
        REFERENCES issues(repository_id, id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, change_id)
        REFERENCES changes(repository_id, change_id) ON DELETE CASCADE
);

CREATE INDEX idx_issue_change_links_change
    ON issue_change_links (repository_id, change_id, issue_id);

CREATE TABLE IF NOT EXISTS analyzer_runs (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    change_id       VARCHAR(255) NOT NULL,
    revision_seq    BIGINT NOT NULL CHECK (revision_seq > 0),
    name            TEXT NOT NULL CHECK (btrim(name) <> ''),
    state           VARCHAR(16) NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'paused')),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    paused_by       TEXT,
    paused_reason   TEXT,
    failure_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT analyzer_runs_pause_detail_check CHECK (
        (state = 'paused' AND paused_by IS NOT NULL AND btrim(paused_by) <> ''
            AND paused_reason IS NOT NULL AND btrim(paused_reason) <> '')
        OR (state <> 'paused' AND paused_by IS NULL AND paused_reason IS NULL)
    ),
    CONSTRAINT analyzer_runs_failure_detail_check CHECK (
        (state = 'failed' AND failure_reason IS NOT NULL AND btrim(failure_reason) <> '')
        OR (state <> 'failed' AND failure_reason IS NULL)
    ),
    FOREIGN KEY (repository_id, change_id, revision_seq)
        REFERENCES change_revisions(repository_id, change_id, seq) ON DELETE CASCADE,
    UNIQUE (repository_id, change_id, revision_seq, name)
);

CREATE INDEX idx_analyzer_runs_change_revision
    ON analyzer_runs (repository_id, change_id, revision_seq, name);

CREATE TABLE IF NOT EXISTS findings (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    change_id       VARCHAR(255) NOT NULL,
    revision_seq    BIGINT NOT NULL CHECK (revision_seq > 0),
    analyzer        TEXT NOT NULL CHECK (btrim(analyzer) <> ''),
    source          VARCHAR(16) NOT NULL CHECK (source IN ('analyzer', 'reviewer')),
    path            TEXT NOT NULL CHECK (btrim(path) <> ''),
    line            BIGINT NOT NULL CHECK (line > 0),
    side            VARCHAR(8) NOT NULL DEFAULT 'right' CHECK (side IN ('left', 'right', 'both')),
    severity        TEXT NOT NULL CHECK (btrim(severity) <> ''),
    text            TEXT NOT NULL CHECK (btrim(text) <> ''),
    suggestion      TEXT,
    anchor_hash     TEXT,
    feedback        VARCHAR(16) CHECK (feedback IN ('useful', 'not_useful', 'fixed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (repository_id, change_id, revision_seq)
        REFERENCES change_revisions(repository_id, change_id, seq) ON DELETE CASCADE
);

CREATE INDEX idx_findings_change_revision
    ON findings (repository_id, change_id, revision_seq, analyzer, id);

CREATE TABLE IF NOT EXISTS finding_feedback (
    finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    useful     BOOLEAN NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (finding_id, user_id)
);

CREATE TABLE IF NOT EXISTS change_walkthroughs (
    id                 BIGSERIAL PRIMARY KEY,
    change_revision_id BIGINT NOT NULL UNIQUE REFERENCES change_revisions(id) ON DELETE CASCADE,
    sections           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sections) = 'array'),
    quiz               JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quiz) = 'array'),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    require_human_approvals BIGINT NOT NULL DEFAULT 1 CHECK (require_human_approvals >= 0),
    require_agent_lgtm  BOOLEAN NOT NULL DEFAULT FALSE,
    required_checks     TEXT[] NOT NULL DEFAULT '{}'::text[],
    require_status_checks     BOOLEAN NOT NULL DEFAULT FALSE,
    required_status_contexts  TEXT[] NOT NULL DEFAULT '{}',
    dismiss_stale_reviews BOOLEAN NOT NULL DEFAULT FALSE,
    restrict_push_teams TEXT[] NOT NULL DEFAULT '{}'::text[],
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
    -- The workspace FK is attached after workspaces is declared below.
    -- NULL means the operation originated on a computer the server cannot
    -- execute in (for example, a laptop push).
    workspace_id         UUID,
    change_ids           TEXT[] NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, operation_id)
);

CREATE INDEX idx_jj_operations_repo_created_at ON jj_operations (repository_id, created_at DESC, id DESC);
CREATE INDEX idx_jj_operations_workspace_created_at
    ON jj_operations (workspace_id, created_at DESC, id DESC)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_jj_operations_change_ids_gin
    ON jj_operations USING GIN (change_ids);

-- Reactions (issue/landing/comment targets)
-- user_id is nullable with ON DELETE SET NULL so that reaction rows survive
-- user deletion. The reaction count and timeline history are preserved even
-- after the author account is removed. A partial unique index enforces
-- deduplication only for non-deleted (non-NULL user_id) reactions; reactions
-- with a NULL user_id are tombstones and are not subject to the constraint.
CREATE TABLE IF NOT EXISTS reactions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    target_type  VARCHAR(32) NOT NULL CHECK (target_type IN ('issue', 'issue_comment', 'landing_request', 'landing_comment')),
    target_id    BIGINT NOT NULL,
    emoji        VARCHAR(64) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: deduplicate reactions only when a known user is
-- attached. NULL user_id rows (tombstoned reactions) are not subject to
-- this constraint since NULL != NULL in unique indexes.
CREATE UNIQUE INDEX uq_reactions_user_target_emoji
    ON reactions (user_id, target_type, target_id, emoji)
    WHERE user_id IS NOT NULL;

CREATE INDEX idx_reactions_target ON reactions (target_type, target_id);

-- reactions.target_id is polymorphic so it cannot carry a foreign key; the
-- database cleans up reaction rows itself when a target row disappears. Row
-- triggers also fire for FK-cascade deletes (e.g. deleting a repository
-- cascades its issues and comments), so no application path can leak
-- orphaned reactions.
CREATE OR REPLACE FUNCTION delete_reactions_for_target()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM reactions
    WHERE target_type = TG_ARGV[0]
      AND target_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_delete_reactions
    AFTER DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('issue');

CREATE TRIGGER trg_issue_comments_delete_reactions
    AFTER DELETE ON issue_comments
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('issue_comment');

CREATE TRIGGER trg_landing_requests_delete_reactions
    AFTER DELETE ON landing_requests
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('landing_request');

CREATE TRIGGER trg_landing_request_comments_delete_reactions
    AFTER DELETE ON landing_request_comments
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('landing_comment');

-- Mentions
-- mentioned_user_id uses ON DELETE SET NULL so that mention history rows
-- survive when the mentioned account is deleted. Tombstone rows
-- (mentioned_user_id IS NULL) record that a mention occurred even after
-- the target user is gone. The partial unique indexes below only enforce
-- deduplication for non-NULL mentioned_user_id values.
CREATE TABLE IF NOT EXISTS mentions (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_id           BIGINT REFERENCES issues(id) ON DELETE CASCADE,
    landing_request_id BIGINT REFERENCES landing_requests(id) ON DELETE CASCADE,
    comment_type       VARCHAR(32) NOT NULL CHECK (comment_type IN ('issue_comment', 'landing_comment', 'issue_body', 'landing_body')),
    comment_id         BIGINT,
    user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
    mentioned_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique indexes for mention deduplication. A plain unique constraint
-- cannot enforce uniqueness when comment_id IS NULL (body mentions) because
-- NULL != NULL in SQL. The indexes are split into three cases:
--   1. comment-level mentions  (comment_id IS NOT NULL)
--   2. issue body mentions     (comment_id IS NULL, issue_id IS NOT NULL)
--   3. landing body mentions   (comment_id IS NULL, landing_request_id IS NOT NULL)
-- All three only fire when mentioned_user_id IS NOT NULL; tombstone rows
-- (mentioned_user_id IS NULL from ON DELETE SET NULL) are excluded.
CREATE UNIQUE INDEX uq_mentions_comment
    ON mentions (comment_type, comment_id, mentioned_user_id)
    WHERE comment_id IS NOT NULL AND mentioned_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_mentions_body_issue
    ON mentions (comment_type, issue_id, mentioned_user_id)
    WHERE comment_id IS NULL AND issue_id IS NOT NULL AND mentioned_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_mentions_body_landing
    ON mentions (comment_type, landing_request_id, mentioned_user_id)
    WHERE comment_id IS NULL AND landing_request_id IS NOT NULL AND mentioned_user_id IS NOT NULL;

CREATE INDEX idx_mentions_mentioned_user ON mentions (mentioned_user_id, created_at DESC)
    WHERE mentioned_user_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS workflow_triggers (
    id                     BIGSERIAL PRIMARY KEY,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    workflow_path          TEXT NOT NULL,
    event_type             VARCHAR(64) NOT NULL,
    event_action           VARCHAR(64) NOT NULL DEFAULT '',
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, workflow_path, event_type, event_action)
);

CREATE INDEX idx_workflow_triggers_repo_event
    ON workflow_triggers (repository_id, event_type, event_action)
    WHERE enabled = TRUE;

CREATE INDEX idx_workflow_triggers_definition
    ON workflow_triggers (workflow_definition_id);

CREATE TABLE IF NOT EXISTS workflow_schedule_specs (
    id                     BIGSERIAL PRIMARY KEY,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    cron_expression        TEXT NOT NULL,
    next_fire_at           TIMESTAMPTZ NOT NULL,
    prev_fire_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_definition_id, cron_expression)
);

CREATE INDEX idx_workflow_schedule_specs_next_fire
    ON workflow_schedule_specs (next_fire_at ASC);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id                     BIGSERIAL PRIMARY KEY,
    repository_id          BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    status                 VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failure', 'cancelled')),
    trigger_event          VARCHAR(64) NOT NULL,
    trigger_ref            VARCHAR(255) NOT NULL DEFAULT '',
    trigger_commit_sha     VARCHAR(255) NOT NULL DEFAULT '',
    dispatch_inputs        JSONB,
    agent_token_hash       VARCHAR(64) UNIQUE,
    agent_token_expires_at TIMESTAMPTZ,
    jjhub_token_id         BIGINT,
    check_run_id           BIGINT,
    check_run_url          TEXT,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Single authoritative execution-plane discriminator. Exactly one consumer
    -- may claim work for a run: 'runner' runs are executed by the GKE/gVisor
    -- task runner (ClaimPendingTask), 'sandbox' runs by the sandbox
    -- whole-workflow scheduler (ClaimQueuedWorkflowRuns), and 'agent' runs
    -- solely by agent dispatch (neither queue consumer claims them).
    execution_plane        VARCHAR(16) NOT NULL DEFAULT 'runner' CHECK (execution_plane IN ('runner', 'sandbox', 'agent')),
    log_bytes              BIGINT NOT NULL DEFAULT 0 CONSTRAINT workflow_runs_log_bytes_nonnegative CHECK (log_bytes >= 0),
    log_entry_count        BIGINT NOT NULL DEFAULT 0 CONSTRAINT workflow_runs_log_entry_count_nonnegative CHECK (log_entry_count >= 0),
    -- Why a run ended up 'cancelled'. Empty for an operator/API cancel;
    -- 'superseded_by_run:<id>' when a newer push run to the same
    -- (repository, definition, trigger_ref) cancelled this one.
    cancel_reason          VARCHAR(128) NOT NULL DEFAULT ''
);

-- A run participates in strict O(1) log-budget admission only after its two
-- historical log tables have been recounted while holding the run-row lock.
-- New runs receive the marker immediately; the background backfiller adds it
-- to one legacy run per short transaction.
CREATE TABLE IF NOT EXISTS workflow_log_budget_initializations (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    initialized_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Durable ownership for whole-workflow sandbox execution lives outside
-- workflow_runs so adding the lease does not change the SELECT/RETURNING * row
-- shape consumed by previous-version binaries during a rolling deployment.
CREATE TABLE IF NOT EXISTS workflow_sandbox_claims (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    generation BIGINT NOT NULL DEFAULT 0
        CONSTRAINT workflow_sandbox_claims_generation_nonnegative CHECK (generation >= 0),
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    CONSTRAINT workflow_sandbox_claims_active_fields_match CHECK (
        (claim_token IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
        OR
        (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_workflow_sandbox_claims_active_token
    ON workflow_sandbox_claims (claim_token)
    WHERE claim_token IS NOT NULL;

CREATE INDEX idx_workflow_sandbox_claims_expiry
    ON workflow_sandbox_claims (lease_expires_at, workflow_run_id)
    WHERE claim_token IS NOT NULL;

-- Agent definitions are identified by a sentinel path. Force their run plane
-- at insert so callers that omit execution_plane cannot expose agent work to
-- the standard task runner.
CREATE OR REPLACE FUNCTION force_agent_workflow_run_execution_plane()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM workflow_definitions wd
        WHERE wd.id = NEW.workflow_definition_id
          AND wd.path = '.smithers/agent'
    ) THEN
        NEW.execution_plane := 'agent';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_10_force_agent_plane ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_10_force_agent_plane
    BEFORE INSERT ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION force_agent_workflow_run_execution_plane();

CREATE OR REPLACE FUNCTION guard_workflow_run_execution_plane_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.execution_plane IS DISTINCT FROM OLD.execution_plane THEN
        RAISE EXCEPTION 'workflow_run % execution_plane is immutable (% -> %)',
            OLD.id, OLD.execution_plane, NEW.execution_plane
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_20_execution_plane_immutable ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_20_execution_plane_immutable
    BEFORE UPDATE OF execution_plane ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_run_execution_plane_immutable();

CREATE OR REPLACE FUNCTION guard_workflow_run_status_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'queued'
       AND NEW.status = 'running'
       AND OLD.execution_plane IS DISTINCT FROM 'sandbox'
       AND current_setting('smithers.workflow_run_status_id', true)
           IS DISTINCT FROM OLD.id::text THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_30_status_claim_guard ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_30_status_claim_guard
    BEFORE UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_run_status_claim();

CREATE OR REPLACE FUNCTION guard_workflow_sandbox_terminal_claim()
RETURNS TRIGGER AS $$
DECLARE
    active_claim workflow_sandbox_claims%ROWTYPE;
BEGIN
    IF OLD.execution_plane IS DISTINCT FROM 'sandbox'
       OR NEW.status NOT IN ('success', 'failure') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'queued' THEN
        RETURN NULL;
    END IF;

    SELECT *
    INTO active_claim
    FROM workflow_sandbox_claims
    WHERE workflow_run_id = OLD.id
      AND claim_token IS NOT NULL;

    IF FOUND
       AND (
           current_setting('smithers.workflow_sandbox_claim_token', true)
               IS DISTINCT FROM active_claim.claim_token::text
           OR current_setting('smithers.workflow_sandbox_claim_generation', true)
               IS DISTINCT FROM active_claim.generation::text
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_40_sandbox_terminal_claim_guard ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_40_sandbox_terminal_claim_guard
    BEFORE UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_sandbox_terminal_claim();

CREATE OR REPLACE FUNCTION invalidate_workflow_sandbox_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.execution_plane = 'sandbox'
       AND NEW.status IN ('success', 'failure', 'cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE workflow_sandbox_claims
        SET generation = generation + 1,
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE workflow_run_id = NEW.id
          AND claim_token IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_runs_90_invalidate_sandbox_claim ON workflow_runs;

CREATE TRIGGER trg_workflow_runs_90_invalidate_sandbox_claim
    AFTER UPDATE OF status ON workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION invalidate_workflow_sandbox_claim();

CREATE INDEX idx_workflow_runs_repo_id ON workflow_runs (repository_id, created_at DESC);
CREATE INDEX idx_workflow_runs_status_partial ON workflow_runs (repository_id, created_at DESC) WHERE status IN ('queued', 'running');
CREATE INDEX idx_workflow_runs_agent_token ON workflow_runs (agent_token_hash) WHERE agent_token_hash IS NOT NULL;
CREATE INDEX idx_workflow_runs_sandbox_claim ON workflow_runs (created_at ASC, id ASC) WHERE status = 'queued' AND execution_plane = 'sandbox';
-- Supersede lookup: older non-terminal runs of one (repo, definition, ref).
CREATE INDEX idx_workflow_runs_active_by_ref ON workflow_runs (repository_id, workflow_definition_id, trigger_ref, id) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX idx_workflow_runs_alert_remediation_dispatch_token
    ON workflow_runs ((dispatch_inputs ->> 'remediation_dispatch_token'))
    WHERE trigger_event = 'monitoring_alert'
      AND execution_plane = 'runner'
      AND dispatch_inputs ? 'remediation_dispatch_token';
CREATE INDEX idx_workflow_runs_legacy_alert_incident
    ON workflow_runs (
        (dispatch_inputs ->> 'incident_row_id'),
        (dispatch_inputs ->> 'incident_id'),
        status
    )
    WHERE trigger_event = 'monitoring_alert'
      AND execution_plane = 'runner'
      AND NOT (dispatch_inputs ? 'remediation_dispatch_token');

CREATE TABLE IF NOT EXISTS workflow_steps (
    id               BIGSERIAL PRIMARY KEY,
    workflow_run_id  BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    -- Ticket 0147: repository_id denormalized from the parent workflow_run so
    -- the realtime run-inspection stream (ShapeWorkflowRunSteps) can carry the
    -- `repository_id IN (...)` predicate the proxy requires for auth.
    -- Populated automatically by the trg_workflow_steps_repository_id trigger
    -- on INSERT — callers that already know the repo may set it explicitly.
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    position         BIGINT NOT NULL,
    status           VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failure', 'skipped', 'cancelled')),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_run_id, position)
);

CREATE OR REPLACE FUNCTION set_workflow_step_repository_id()
RETURNS TRIGGER AS $$
DECLARE
    expected_repository_id BIGINT;
BEGIN
    SELECT repository_id
    INTO expected_repository_id
    FROM workflow_runs
    WHERE id = NEW.workflow_run_id;

    IF expected_repository_id IS NULL THEN
        RAISE EXCEPTION 'workflow_run % not found for workflow_step', NEW.workflow_run_id;
    END IF;

    NEW.repository_id := expected_repository_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_steps_repository_id ON workflow_steps;

CREATE TRIGGER trg_workflow_steps_repository_id
    BEFORE INSERT OR UPDATE ON workflow_steps
    FOR EACH ROW
    EXECUTE FUNCTION set_workflow_step_repository_id();

CREATE INDEX idx_workflow_steps_run_id ON workflow_steps (workflow_run_id, position);
-- Ticket 0147: realtime stream where-template index — `repository_id IN (...)
-- AND workflow_run_id IN (...)` ordered by position on the client side.
CREATE INDEX idx_workflow_steps_repo_run_position
    ON workflow_steps (repository_id, workflow_run_id, position);

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
    status            VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'assigned', 'running', 'done', 'failed', 'cancelled', 'blocked', 'skipped')),
    priority          SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
    payload           JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt           INTEGER NOT NULL DEFAULT 0,
    runner_id         BIGINT,
    vm_id             TEXT,
    assigned_at       TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- workflow_tasks.repository_id is denormalized for realtime stream scoping and
-- authorization; like workflow_steps above, the database derives it from the
-- parent step (which is itself forced to match the run) and rejects tasks
-- whose run does not own the step, so a task can never be streamed or
-- authorized under the wrong repository.
CREATE OR REPLACE FUNCTION set_workflow_task_repository_id()
RETURNS TRIGGER AS $$
DECLARE
    step_run_id BIGINT;
    step_repository_id BIGINT;
BEGIN
    SELECT workflow_run_id, repository_id
    INTO step_run_id, step_repository_id
    FROM workflow_steps
    WHERE id = NEW.workflow_step_id;

    IF step_repository_id IS NULL THEN
        RAISE EXCEPTION 'workflow_step % not found for workflow_task', NEW.workflow_step_id;
    END IF;
    IF step_run_id <> NEW.workflow_run_id THEN
        RAISE EXCEPTION 'workflow_task run % does not match run % of workflow_step %',
            NEW.workflow_run_id, step_run_id, NEW.workflow_step_id;
    END IF;

    NEW.repository_id := step_repository_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_tasks_repository_id
    BEFORE INSERT OR UPDATE ON workflow_tasks
    FOR EACH ROW
    EXECUTE FUNCTION set_workflow_task_repository_id();

CREATE OR REPLACE FUNCTION guard_workflow_task_execution_plane_claim()
RETURNS TRIGGER AS $$
DECLARE
    parent_execution_plane VARCHAR(16);
BEGIN
    IF NOT (
        (OLD.status = 'pending' AND NEW.status = 'assigned')
        OR (OLD.status = 'assigned' AND NEW.status = 'running')
    ) THEN
        RETURN NEW;
    END IF;

    SELECT execution_plane
    INTO parent_execution_plane
    FROM workflow_runs
    WHERE id = OLD.workflow_run_id;

    IF OLD.status = 'pending' AND NEW.status = 'assigned' THEN
        IF parent_execution_plane IS DISTINCT FROM 'runner'
           OR NEW.runner_id IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN NEW;
    END IF;

    IF parent_execution_plane = 'runner' THEN
        IF NEW.runner_id IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN NEW;
    END IF;

    IF parent_execution_plane = 'agent'
       AND OLD.runner_id IS NULL
       AND NEW.runner_id IS NULL
       AND NEW.vm_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_tasks_20_execution_plane_claim_guard ON workflow_tasks;

CREATE TRIGGER trg_workflow_tasks_20_execution_plane_claim_guard
    BEFORE UPDATE OF status ON workflow_tasks
    FOR EACH ROW
    EXECUTE FUNCTION guard_workflow_task_execution_plane_claim();

CREATE INDEX idx_workflow_tasks_pending_dequeue
    ON workflow_tasks (priority DESC, created_at ASC, id ASC, available_at ASC)
    WHERE status = 'pending';
CREATE INDEX idx_workflow_tasks_runner_id
    ON workflow_tasks (runner_id)
    WHERE runner_id IS NOT NULL;
CREATE INDEX idx_workflow_tasks_active_repo
    ON workflow_tasks (repository_id)
    WHERE status IN ('assigned', 'running');
-- Lock the run before checking its task state. Each statement in this
-- VOLATILE function takes a fresh READ COMMITTED snapshot, including after a
-- competing claim releases the run lock. The marker and claim share that lock.
CREATE OR REPLACE FUNCTION runner_queue_timeout_admissible(
    candidate_run_id bigint,
    candidate_repository_id bigint
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    expired boolean;
BEGIN
    PERFORM 1 FROM workflow_runs wr
    WHERE wr.id = candidate_run_id
      AND wr.repository_id = candidate_repository_id
      AND wr.execution_plane = 'runner'
      AND wr.status IN ('queued', 'running')
    FOR UPDATE OF wr;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM workflow_tasks wt
        WHERE wt.workflow_run_id = candidate_run_id
          AND wt.status = 'pending'
          AND wt.available_at <= NOW() - INTERVAL '120 seconds'
    ) AND NOT EXISTS (
        SELECT 1 FROM workflow_tasks wt
        WHERE wt.workflow_run_id = candidate_run_id
          AND wt.status IN ('assigned', 'running')
    ) INTO expired;
    RETURN expired;
END;
$$;

CREATE OR REPLACE FUNCTION runner_claim_admissible(
    candidate_repository_id bigint,
    candidate_manual boolean,
    gate_acquired boolean
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    repository_active bigint;
    background_active bigint;
BEGIN
    IF NOT gate_acquired THEN
        RETURN false;
    END IF;
    SELECT COUNT(*) INTO repository_active
    FROM workflow_tasks active
    JOIN workflow_runs active_run ON active_run.id = active.workflow_run_id
    WHERE active.repository_id = candidate_repository_id
      AND active.status IN ('assigned', 'running')
      AND active_run.execution_plane = 'runner';
    IF repository_active >= 3 THEN
        RETURN false;
    END IF;
    IF candidate_manual THEN
        RETURN true;
    END IF;
    SELECT COUNT(*) INTO background_active
    FROM workflow_tasks active
    JOIN workflow_runs active_run ON active_run.id = active.workflow_run_id
    WHERE active.status IN ('assigned', 'running')
      AND active_run.execution_plane = 'runner'
      AND active_run.trigger_event NOT IN ('manual_dispatch', 'workflow_dispatch');
    RETURN background_active < 3;
END;
$$;

CREATE INDEX idx_workflow_tasks_vm_id
    ON workflow_tasks (vm_id)
    WHERE vm_id IS NOT NULL;
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

CREATE TABLE IF NOT EXISTS workflow_run_logs (
    id               BIGINT PRIMARY KEY DEFAULT nextval('workflow_logs_id_seq'),
    workflow_run_id  BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    sequence         BIGINT NOT NULL,
    stream           VARCHAR(16) NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
    entry            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_run_id, sequence)
);

CREATE INDEX idx_workflow_run_logs_run_id ON workflow_run_logs (workflow_run_id, id);

CREATE OR REPLACE FUNCTION initialize_new_workflow_log_budget()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO workflow_log_budget_initializations (workflow_run_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_runs_initialize_log_budget
    AFTER INSERT ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION initialize_new_workflow_log_budget();

-- Serialize and enforce the combined workflow-log budget on the parent run.
-- Both log tables use the same row, so old binaries and direct inserts cannot
-- bypass the 50 MiB / 100,000-entry ceilings or make admission scan history.
-- Legacy runs remain permissive only until the bounded backfill initializes
-- their exact counters under this same run-row lock.
CREATE OR REPLACE FUNCTION reserve_workflow_log_budget()
RETURNS TRIGGER AS $$
DECLARE
    v_entry_bytes BIGINT := OCTET_LENGTH(NEW.entry)::bigint;
    v_initialized BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = NEW.workflow_run_id
    )
    INTO v_initialized
    FROM workflow_runs AS run
    WHERE run.id = NEW.workflow_run_id
    FOR UPDATE OF run;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NOT v_initialized THEN
        RETURN NEW;
    END IF;

    UPDATE workflow_runs
    SET log_bytes = log_bytes + v_entry_bytes,
        log_entry_count = log_entry_count + 1
    WHERE id = NEW.workflow_run_id
      AND log_bytes <= 52428800::bigint - v_entry_bytes
      AND log_entry_count < 100000::bigint;

    IF FOUND THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'workflow run % log storage limit reached', NEW.workflow_run_id
        USING ERRCODE = '54000',
              CONSTRAINT = 'workflow_run_log_budget';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_workflow_log_budget()
RETURNS TRIGGER AS $$
DECLARE
    v_initialized BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = OLD.workflow_run_id
    )
    INTO v_initialized
    FROM workflow_runs AS run
    WHERE run.id = OLD.workflow_run_id
    FOR UPDATE OF run;

    IF NOT FOUND OR NOT v_initialized THEN
        RETURN OLD;
    END IF;

    UPDATE workflow_runs
    SET log_bytes = GREATEST(log_bytes - OCTET_LENGTH(OLD.entry)::bigint, 0),
        log_entry_count = GREATEST(log_entry_count - 1, 0)
    WHERE id = OLD.workflow_run_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_workflow_log_budget_identity()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
       OR NEW.entry IS DISTINCT FROM OLD.entry THEN
        RAISE EXCEPTION 'workflow log run and entry are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recount one legacy run per transaction under the same parent-row lock used
-- by both log mutation triggers. This makes the rollout bounded and resumable
-- while preserving an exact cut between legacy and counter-backed admission.
CREATE OR REPLACE FUNCTION backfill_one_workflow_log_budget()
RETURNS BIGINT AS $$
DECLARE
    v_workflow_run_id BIGINT;
    v_log_bytes BIGINT;
    v_log_entry_count BIGINT;
BEGIN
    SELECT run.id
    INTO v_workflow_run_id
    FROM workflow_runs AS run
    WHERE NOT EXISTS (
        SELECT 1
        FROM workflow_log_budget_initializations AS initialized
        WHERE initialized.workflow_run_id = run.id
    )
    ORDER BY run.id
    FOR UPDATE OF run SKIP LOCKED
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT
        COALESCE(SUM(table_log_bytes), 0)::bigint,
        COALESCE(SUM(table_log_entry_count), 0)::bigint
    INTO v_log_bytes, v_log_entry_count
    FROM (
        SELECT
            COALESCE(SUM(OCTET_LENGTH(entry)::bigint), 0)::bigint AS table_log_bytes,
            COUNT(*)::bigint AS table_log_entry_count
        FROM workflow_logs
        WHERE workflow_run_id = v_workflow_run_id
        UNION ALL
        SELECT
            COALESCE(SUM(OCTET_LENGTH(entry)::bigint), 0)::bigint AS table_log_bytes,
            COUNT(*)::bigint AS table_log_entry_count
        FROM workflow_run_logs
        WHERE workflow_run_id = v_workflow_run_id
    ) AS usage;

    UPDATE workflow_runs
    SET log_bytes = v_log_bytes,
        log_entry_count = v_log_entry_count
    WHERE id = v_workflow_run_id;

    INSERT INTO workflow_log_budget_initializations (workflow_run_id)
    VALUES (v_workflow_run_id)
    ON CONFLICT (workflow_run_id) DO NOTHING;

    RETURN v_workflow_run_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_logs_reserve_budget
    BEFORE INSERT ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION reserve_workflow_log_budget();
CREATE TRIGGER trg_workflow_run_logs_reserve_budget
    BEFORE INSERT ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION reserve_workflow_log_budget();
CREATE TRIGGER trg_workflow_logs_release_budget
    BEFORE DELETE ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION release_workflow_log_budget();
CREATE TRIGGER trg_workflow_run_logs_release_budget
    BEFORE DELETE ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION release_workflow_log_budget();
CREATE TRIGGER trg_workflow_logs_guard_budget_identity
    BEFORE UPDATE OF workflow_run_id, entry ON workflow_logs
    FOR EACH ROW EXECUTE FUNCTION guard_workflow_log_budget_identity();
CREATE TRIGGER trg_workflow_run_logs_guard_budget_identity
    BEFORE UPDATE OF workflow_run_id, entry ON workflow_run_logs
    FOR EACH ROW EXECUTE FUNCTION guard_workflow_log_budget_identity();

CREATE TABLE IF NOT EXISTS github_proxy_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    workflow_run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    method          VARCHAR(16) NOT NULL,
    path            TEXT NOT NULL,
    status_code     INTEGER NOT NULL,
    decision        VARCHAR(16) NOT NULL CHECK (decision IN ('allow', 'deny')),
    reason          TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_proxy_audit_log_workflow_run_created
    ON github_proxy_audit_log (workflow_run_id, created_at DESC);

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
    targets_affected BIGINT NOT NULL DEFAULT 0 CONSTRAINT commit_statuses_targets_affected_nonnegative CHECK (targets_affected >= 0),
    targets_ran      BIGINT NOT NULL DEFAULT 0 CONSTRAINT commit_statuses_targets_ran_nonnegative CHECK (targets_ran >= 0),
    targets_cached   BIGINT NOT NULL DEFAULT 0 CONSTRAINT commit_statuses_targets_cached_nonnegative CHECK (targets_cached >= 0),
    duration_ms      BIGINT NOT NULL DEFAULT 0 CONSTRAINT commit_statuses_duration_ms_nonnegative CHECK (duration_ms >= 0),
    workspace_id     UUID,
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
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    -- RFD-004: the workspace this run executes in (FK added below, forward reference).
    workspace_id     UUID,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Soft-delete tombstone for ticket 0114. NULL means "live row"; a non-NULL
    -- value means the session was deleted and is hidden from the public API,
    -- but the row remains so realtime subscribers can observe the
    -- visible->hidden transition and locally purge their cached copy.
    deleted_at       TIMESTAMPTZ
);

CREATE INDEX idx_agent_sessions_repo_id ON agent_sessions (repository_id, created_at DESC);
-- Partial index on live rows for the common list-active-sessions-by-repo path.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_live_by_repo
    ON agent_sessions (repository_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_agent_sessions_active_finding_dispatch
    ON agent_sessions ((metadata ->> 'finding_id'))
    WHERE status = 'active'
      AND deleted_at IS NULL
      AND metadata ? 'finding_id';

CREATE TABLE IF NOT EXISTS agent_messages (
    id          BIGSERIAL PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    -- Ticket 0115: denormalized repository_id. Populated from the parent
    -- agent_session on every insert so realtime stream subscriptions can
    -- filter `repository_id IN (...) AND session_id IN (...)` without a
    -- join.
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    sequence    BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, sequence)
);

CREATE INDEX idx_agent_messages_session_id ON agent_messages (session_id, sequence);
-- Ticket 0115: backs the production shape filter
-- `repository_id IN (...) AND session_id IN (...)` ordered by sequence.
CREATE INDEX IF NOT EXISTS idx_agent_messages_repo_session_sequence
    ON agent_messages (repository_id, session_id, sequence);

-- part content schema (object root)
CREATE TABLE IF NOT EXISTS agent_parts (
    id          BIGSERIAL PRIMARY KEY,
    message_id  BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    -- Ticket 0118: denormalized repository_id + session_id. Populated from
    -- the parent message's session on every insert so realtime stream
    -- subscriptions can filter on `repository_id IN (...) AND session_id
    -- IN (...)` without joining through agent_messages. See
    -- the parent row.
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    session_id  UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    part_index  BIGINT NOT NULL,
    part_type   VARCHAR(32) NOT NULL,
    content     JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, part_index)
);

CREATE INDEX idx_agent_parts_message_id ON agent_parts (message_id, part_index);
CREATE INDEX idx_agent_parts_content_gin ON agent_parts USING GIN (content);
-- Ticket 0118: backs the production shape filter
-- `repository_id IN (...) AND session_id IN (...)` ordered by
-- (message_id, part_index) for transcript replay.
CREATE INDEX IF NOT EXISTS idx_agent_parts_repo_session_message_partindex
    ON agent_parts (repository_id, session_id, message_id, part_index);

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

-- Notification lifecycle facts. The per-user head is updated under a lock;
-- unlike BIGSERIAL, this is a committed, gap-free position within this journal.
CREATE TABLE notification_journals (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    head BIGINT NOT NULL DEFAULT 0 CHECK (head >= 0),
    coverage_kind TEXT NOT NULL DEFAULT 'from_creation'
        CHECK (coverage_kind IN ('legacy_snapshot', 'from_creation')),
    coverage_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE notification_facts (
    user_id BIGINT NOT NULL REFERENCES notification_journals(user_id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'notification.baseline', 'notification.created', 'notification.read',
        'notification.unread', 'notification.updated', 'notification.deleted'
    )),
    notification_id BIGINT NOT NULL,
    post_image JSONB NOT NULL CHECK (jsonb_typeof(post_image) = 'object'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, sequence)
);
CREATE INDEX idx_notification_facts_notification ON notification_facts (user_id, notification_id, sequence);

CREATE OR REPLACE FUNCTION lock_notification_journal()
RETURNS TRIGGER AS $$
DECLARE recipient BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id) THEN
        RAISE EXCEPTION 'notification identity is immutable' USING ERRCODE = '23514';
    END IF;
    recipient := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    -- Match the existing creation query lock order: user, then journal. All
    -- service update queries also lock this user before touching child rows.
    -- On a user FK cascade the user is already absent, so no fact is retained.
    PERFORM users.id FROM users WHERE users.id = recipient FOR UPDATE;
    IF FOUND THEN
        INSERT INTO notification_journals (user_id) VALUES (recipient)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM user_id FROM notification_journals WHERE user_id = recipient FOR UPDATE;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_notification_fact()
RETURNS TRIGGER AS $$
DECLARE
    recipient BIGINT;
    record_id BIGINT;
    position BIGINT;
    kind TEXT;
    image JSONB;
BEGIN
    recipient := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    IF NOT EXISTS (SELECT 1 FROM users WHERE users.id = recipient) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        record_id := OLD.id;
        image := to_jsonb(OLD) - 'user_id';
        kind := 'notification.deleted';
    ELSE
        record_id := NEW.id;
        image := to_jsonb(NEW) - 'user_id';
        IF TG_OP = 'INSERT' THEN kind := 'notification.created';
        ELSIF NEW.status = 'read' AND (OLD.status <> NEW.status OR OLD.read_at IS DISTINCT FROM NEW.read_at) THEN kind := 'notification.read';
        ELSIF NEW.status = 'unread' AND OLD.status <> NEW.status THEN kind := 'notification.unread';
        ELSE kind := 'notification.updated';
        END IF;
    END IF;
    -- The BEFORE trigger holds user/journal locks before allocating this
    -- position; both head and fact disappear if this mutation rolls back.
    UPDATE notification_journals SET head = head + 1 WHERE user_id = recipient
    RETURNING head INTO STRICT position;
    INSERT INTO notification_facts (user_id, sequence, event_type, notification_id, post_image)
    VALUES (recipient, position, kind, record_id, image);
    -- PostgreSQL delivers this only after the surrounding mutation commits.
    PERFORM pg_notify('notification_facts_' || recipient::text, position::text);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_notification_fact_history()
RETURNS TRIGGER AS $$
BEGIN
    -- Deleting a recipient must delete their private journal without an
    -- append-only guard breaking FK cascades or retaining personal snippets.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = OLD.user_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'notification facts are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notifications_journal_lock
    BEFORE INSERT OR UPDATE OR DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION lock_notification_journal();
CREATE TRIGGER trg_notifications_record_fact
    AFTER INSERT OR UPDATE OR DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION record_notification_fact();
CREATE TRIGGER trg_notification_facts_immutable
    BEFORE UPDATE OR DELETE ON notification_facts
    FOR EACH ROW EXECUTE FUNCTION guard_notification_fact_history();

-- Per-user notification preferences: which event categories generate in-app notifications.
-- Missing row means "use defaults" (all enabled). Individual columns are opt-out flags.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notify_issues        BOOLEAN NOT NULL DEFAULT TRUE,
    notify_landings      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_mentions      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Device registrations for approval push notifications.
CREATE TABLE IF NOT EXISTS user_devices (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    apns_token    TEXT NOT NULL,
    platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, apns_token)
);

CREATE INDEX idx_user_devices_user_platform
    ON user_devices (user_id, platform, last_seen_at DESC);

-- Social tables
CREATE TABLE IF NOT EXISTS stars (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repository_id)
);

CREATE INDEX idx_stars_repository_id ON stars (repository_id);

-- Denormalized star counter maintenance. repositories.num_stars is kept in
-- sync by the database itself so concurrent star/unstar toggles for the same
-- (user, repo) are counted exactly once — the triggers only fire when a
-- membership row is actually inserted or deleted (a no-op DELETE or an
-- ON CONFLICT DO NOTHING insert fires nothing). Application code must NOT
-- also adjust num_stars.
CREATE OR REPLACE FUNCTION maintain_repo_star_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_stars = num_stars + 1,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_stars = GREATEST(num_stars - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stars_count_ins
    AFTER INSERT ON stars
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_star_count();

CREATE TRIGGER trg_stars_count_del
    AFTER DELETE ON stars
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_star_count();

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

-- Denormalized watch counter maintenance. repositories.num_watches is kept in
-- sync by the database itself: the upsert used by WatchRepo only fires the
-- INSERT trigger when a new membership row is created (an ON CONFLICT DO
-- UPDATE mode change fires the UPDATE path, which this function ignores), so
-- concurrent watch/unwatch toggles are counted exactly once. Application code
-- must NOT also adjust num_watches.
CREATE OR REPLACE FUNCTION maintain_repo_watch_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_watches = num_watches + 1,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_watches = GREATEST(num_watches - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_watches_count_ins
    AFTER INSERT ON watches
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_watch_count();

CREATE TRIGGER trg_watches_count_del
    AFTER DELETE ON watches
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_watch_count();

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

-- Per-repository webhook cap (must match services.maxWebhooksPerRepo). The
-- application performs a friendly pre-check, but that check-then-insert is
-- racy, so the database enforces the cap atomically: the trigger serializes
-- concurrent inserts for the same repository on its repositories row, then
-- re-counts. Under READ COMMITTED the count after acquiring the lock sees
-- rows committed by the sibling insert that held it.
CREATE OR REPLACE FUNCTION enforce_webhook_repo_cap()
RETURNS TRIGGER AS $$
DECLARE
    hook_count BIGINT;
BEGIN
    PERFORM 1 FROM repositories WHERE id = NEW.repository_id FOR UPDATE;
    SELECT COUNT(*) INTO hook_count
    FROM webhooks
    WHERE repository_id = NEW.repository_id;
    IF hook_count >= 20 THEN
        RAISE EXCEPTION 'repository % already has the maximum of 20 webhooks', NEW.repository_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'webhooks_repo_cap';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_webhooks_repo_cap
    BEFORE INSERT ON webhooks
    FOR EACH ROW
    EXECUTE FUNCTION enforce_webhook_repo_cap();

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

-- GitHub App integration tables
CREATE TABLE IF NOT EXISTS github_app_installations (
    installation_id       BIGINT PRIMARY KEY,
    account_login         VARCHAR(255) NOT NULL DEFAULT '',
    account_type          VARCHAR(64) NOT NULL DEFAULT '',
    repository_selection  VARCHAR(32) NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS github_app_installation_repositories (
    installation_id       BIGINT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
    github_repository_id  BIGINT NOT NULL,
    owner_login           VARCHAR(255) NOT NULL DEFAULT '',
    owner_login_lower     VARCHAR(255) NOT NULL DEFAULT '',
    repo_name             VARCHAR(255) NOT NULL DEFAULT '',
    repo_name_lower       VARCHAR(255) NOT NULL DEFAULT '',
    is_private            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, github_repository_id)
);

CREATE INDEX idx_github_app_installation_repos_owner_repo
    ON github_app_installation_repositories (owner_login_lower, repo_name_lower);
CREATE INDEX idx_github_app_installation_repos_installation
    ON github_app_installation_repositories (installation_id);

CREATE TABLE IF NOT EXISTS github_webhook_jobs (
    id                    BIGSERIAL PRIMARY KEY,
    delivery_id           UUID NOT NULL UNIQUE,
    event_type            VARCHAR(64) NOT NULL,
    action                VARCHAR(64) NOT NULL DEFAULT '',
    installation_id       BIGINT,
    github_repository_id  BIGINT,
    payload               JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status                VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts              INTEGER NOT NULL DEFAULT 0,
    error                 TEXT NOT NULL DEFAULT '',
    available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_webhook_jobs_pending_dequeue
    ON github_webhook_jobs (available_at, id)
    WHERE status = 'pending';
CREATE INDEX idx_github_webhook_jobs_installation
    ON github_webhook_jobs (installation_id, created_at DESC);
CREATE INDEX idx_github_webhook_jobs_repository
    ON github_webhook_jobs (github_repository_id, created_at DESC);

-- Repo connections (user's GitHub repos connected to Smithers)
CREATE TABLE IF NOT EXISTS repo_connections (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_owner       VARCHAR(255) NOT NULL,
    repo_name        VARCHAR(255) NOT NULL,
    repo_owner_lower VARCHAR(255) NOT NULL,
    repo_name_lower  VARCHAR(255) NOT NULL,
    license_spdx_id  VARCHAR(64) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repo_owner_lower, repo_name_lower)
);

CREATE INDEX IF NOT EXISTS idx_repo_connections_user_id ON repo_connections (user_id);

CREATE TABLE IF NOT EXISTS import_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id    BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    workspace_id     UUID,
    github_owner     VARCHAR(255) NOT NULL,
    github_repo      VARCHAR(255) NOT NULL,
    repo_owner       VARCHAR(255) NOT NULL DEFAULT '',
    repo_name        VARCHAR(255) NOT NULL DEFAULT '',
    branch           VARCHAR(255) NOT NULL DEFAULT '',
    target_bookmark  TEXT NOT NULL DEFAULT 'main',
    status           VARCHAR(16) NOT NULL DEFAULT 'cloning'
                     CHECK (status IN ('cloning', 'ready', 'failed')),
    -- Fine-grained progress within 'cloning' (resolving → creating_repo →
    -- cloning_github → pushing_mirror → importing_refs → creating_bookmark →
    -- provisioning_workspace); best-effort, streamed to clients over SSE.
    stage            TEXT NOT NULL DEFAULT '',
    refs_done        BIGINT NOT NULL DEFAULT 0,
    refs_total       BIGINT NOT NULL DEFAULT 0,
    objects_done     BIGINT NOT NULL DEFAULT 0,
    objects_total    BIGINT NOT NULL DEFAULT 0,
    issues_done      BIGINT NOT NULL DEFAULT 0,
    issues_total     BIGINT NOT NULL DEFAULT 0,
    error            TEXT NOT NULL DEFAULT '',
    provisioning_repository_id BIGINT,
    provisioning_token VARCHAR(64),
    claim_token      VARCHAR(64),
    claimed_at       TIMESTAMPTZ,
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_import_jobs_provisioning_binding CHECK (
        (provisioning_repository_id IS NULL AND provisioning_token IS NULL)
        OR
        (provisioning_repository_id IS NOT NULL
         AND provisioning_token ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT ck_import_jobs_claim CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR
        (claim_token ~ '^[0-9a-f]{64}$' AND claimed_at IS NOT NULL)
    ),
    CONSTRAINT ck_import_jobs_progress_nonnegative CHECK (
        refs_done >= 0 AND refs_total >= 0
        AND objects_done >= 0 AND objects_total >= 0
        AND issues_done >= 0 AND issues_total >= 0
    ),
    CONSTRAINT ck_import_jobs_progress_bounds CHECK (
        refs_done <= refs_total
        AND objects_done <= objects_total
        AND issues_done <= issues_total
    )
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user_created
    ON import_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status
    ON import_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_workspace_id
    ON import_jobs (workspace_id)
    WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uq_import_jobs_provisioning_repository
    ON import_jobs (provisioning_repository_id)
    WHERE provisioning_repository_id IS NOT NULL;
CREATE UNIQUE INDEX uq_import_jobs_provisioning_token
    ON import_jobs (provisioning_token)
    WHERE provisioning_token IS NOT NULL;
CREATE INDEX idx_import_jobs_retryable_claim
    ON import_jobs (available_at, claimed_at, created_at, id)
    WHERE status = 'cloning';
CREATE UNIQUE INDEX uq_import_jobs_one_active_source
    ON import_jobs (user_id, LOWER(github_owner), LOWER(github_repo))
    WHERE status = 'cloning';

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

-- Wiki pages
CREATE TABLE IF NOT EXISTS wiki_pages (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    author_id       BIGINT NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, slug)
);

CREATE INDEX idx_wiki_pages_repo ON wiki_pages(repository_id);

-- Workspaces: one pod per user+repo (multi-PTY container)
CREATE TABLE IF NOT EXISTS workspaces (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL DEFAULT '',
    is_fork           BOOLEAN NOT NULL DEFAULT FALSE,
    -- FK to the workspace this was forked from; NULL when not a fork or when
    -- the parent has been deleted. ON DELETE SET NULL preserves the lineage
    -- row rather than cascading the deletion.
    parent_workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    target_bookmark   TEXT NOT NULL DEFAULT 'main',
    -- source_snapshot_id references workspace_snapshots(id) ON DELETE SET NULL.
    -- The FK is added via ALTER TABLE below (after workspace_snapshots is
    -- defined) to avoid a forward-reference at table-creation time.
    source_snapshot_id UUID,
    -- Product execution surface. container keeps the legacy OCI workload;
    -- vm/desktop hand PID 1 to the image's init process.
    kind              TEXT NOT NULL DEFAULT 'container'
                      CONSTRAINT workspaces_kind_check CHECK (kind IN ('container', 'vm', 'desktop', 'agent')),
    environment_source TEXT NOT NULL DEFAULT '.smithers/environment.nix',
    environment_revision TEXT NOT NULL DEFAULT '',
    environment_closure_hash TEXT NOT NULL DEFAULT '',
    -- RFD-004: an agent run's workspace links to its session; the head
    -- reporter's scoped token id is kept so suspend/destroy can revoke it.
    -- The agent_sessions FK is added via ALTER TABLE below (forward reference).
    agent_session_id  UUID,
    head_push_token_id BIGINT REFERENCES access_tokens(id) ON DELETE SET NULL,
    -- Image the workspace booted from (kind vm/desktop: the NixOS closure image).
    environment_image TEXT NOT NULL DEFAULT '',
    -- kind=desktop stream session: opaque id, SHA-256 of the relay token, expiry.
    desktop_session_id TEXT NOT NULL DEFAULT '',
    desktop_session_token_hash TEXT NOT NULL DEFAULT '',
    desktop_session_expires_at TIMESTAMPTZ,
    vm_id             TEXT NOT NULL DEFAULT '',
    -- Bumped once per reprovision attempt. Folded into the sandbox
    -- Idempotency-Key so a replacement create is a NEW logical operation
    -- (a reused key with a different body is a controller 409), while a
    -- retry within one attempt still converges on a single sandbox.
    provisioning_generation INTEGER NOT NULL DEFAULT 0
                      CONSTRAINT workspaces_provisioning_generation_check CHECK (provisioning_generation >= 0),
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed')),
    failure_code      TEXT,
    failure_message   TEXT,
    provisioning_stage TEXT NOT NULL DEFAULT '',
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs INTEGER NOT NULL DEFAULT 1800,
    suspended_at      TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    resumed_at        TIMESTAMPTZ,
    -- Last guest-reported jj working-copy head and divergence from
    -- target_bookmark. The guest reports this atomically after a jj snapshot.
    head_change_id    TEXT NOT NULL DEFAULT '',
    head_commit_id    TEXT NOT NULL DEFAULT '',
    ahead             INTEGER NOT NULL DEFAULT 0 CHECK (ahead >= 0),
    behind            INTEGER NOT NULL DEFAULT 0 CHECK (behind >= 0),
    -- Ticket 0136: server-observed recency for the cross-repo workspace
    -- switcher. Nullable; the 0135 listing query falls through to
    -- last_activity_at / created_at via COALESCE when unset. Explicitly
    -- *not* driven by idle/suspend policy (which still uses
    -- last_activity_at) — touched only from real attach-path flows.
    last_accessed_at  TIMESTAMPTZ,
    -- Ticket 0105: soft-delete tombstone. NULL == live row; non-NULL == gone.
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workspaces_failure_detail_check CHECK (
        (status = 'failed'
            AND failure_code IS NOT NULL AND btrim(failure_code) <> ''
            AND failure_message IS NOT NULL AND btrim(failure_message) <> '')
        OR (status <> 'failed' AND failure_code IS NULL AND failure_message IS NULL)
    )
);

-- The workspace coding host's own run identity for one dispatched agent turn.
-- It lives outside workflow_runs for the same reason workflow_sandbox_claims
-- does: adding a column would change the SELECT/RETURNING * row shape every
-- previous-version binary consumes during a rolling deployment. One row per
-- run, written once the gateway accepts the turn, and it is the handle every
-- gateway projection selector (transcript, run-events, run-tree) takes, so a
-- poller that restarts can find the turn it was streaming.
CREATE TABLE IF NOT EXISTS workflow_run_coding_hosts (
    workflow_run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    host_run_id     TEXT NOT NULL
        CONSTRAINT workflow_run_coding_hosts_host_run_id_present CHECK (host_run_id <> ''),
    flow_id         TEXT NOT NULL
        CONSTRAINT workflow_run_coding_hosts_flow_id_present CHECK (flow_id <> ''),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_run_coding_hosts_workspace
    ON workflow_run_coding_hosts (workspace_id, workflow_run_id);

CREATE OR REPLACE FUNCTION normalize_workspace_failure_details()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'failed' THEN
        NEW.failure_code = COALESCE(NULLIF(btrim(NEW.failure_code), ''), 'provisioning_failed');
        NEW.failure_message = COALESCE(NULLIF(btrim(NEW.failure_message), ''), 'workspace provisioning failed');
    ELSE
        NEW.failure_code = NULL;
        NEW.failure_message = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_normalize_failure_details
    BEFORE INSERT OR UPDATE OF status, failure_code, failure_message ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION normalize_workspace_failure_details();

ALTER TABLE commit_statuses
    ADD CONSTRAINT commit_statuses_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

-- Only one active primary workspace per user+repo+kind. A container, VM, and
-- desktop on the same bookmark are distinct computers. Forks and
-- snapshot-derived workspaces are tracked as separate derived workspaces.
-- Tombstoned rows are excluded per ticket 0105 so a soft-deleted primary
-- doesn't block a re-create on the same repo.
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id, kind)
    WHERE is_fork = FALSE
      AND deleted_at IS NULL
      AND (
          status IN ('running', 'suspended')
          OR (status = 'starting' AND vm_id <> '')
      );
CREATE UNIQUE INDEX uq_workspaces_agent_session
    ON workspaces (agent_session_id)
    WHERE agent_session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_workspaces_status ON workspaces (status)
    WHERE deleted_at IS NULL
      AND status IN ('pending', 'starting', 'running', 'suspended');
-- Ticket 0105: supports per-user active-workspace quota count.
CREATE INDEX IF NOT EXISTS idx_workspaces_user_active
    ON workspaces (user_id)
    WHERE deleted_at IS NULL;
-- Ticket 0136: supports the per-user, recent-first switcher ordering
-- COALESCE(last_accessed_at, last_activity_at, created_at) DESC.
CREATE INDEX IF NOT EXISTS idx_workspaces_user_recency
    ON workspaces (user_id, last_accessed_at DESC NULLS LAST, last_activity_at DESC)
    WHERE deleted_at IS NULL;

-- Per-user active-workspace quota (must match
-- services.MaxActiveWorkspacesPerUser). enforceWorkspaceQuota performs a
-- friendly pre-check, but that check-then-insert is racy across concurrent
-- create/fork/snapshot-restore requests, so the database enforces the cap
-- atomically: the trigger serializes concurrent inserts for the same user on
-- their users row, then re-counts with the same predicate as
-- CountActiveWorkspacesByUser. Under READ COMMITTED the count after acquiring
-- the lock sees rows committed by the sibling insert that held it.
CREATE OR REPLACE FUNCTION enforce_workspace_user_quota()
RETURNS TRIGGER AS $$
DECLARE
    active_count BIGINT;
BEGIN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO active_count
    FROM workspaces
    WHERE user_id = NEW.user_id
      AND deleted_at IS NULL
      AND status <> 'failed';
    IF active_count >= 100 THEN
        RAISE EXCEPTION 'user % already has the maximum of 100 active workspaces', NEW.user_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'workspaces_user_quota';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_user_quota
    BEFORE INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION enforce_workspace_user_quota();

CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id         BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id          TEXT NOT NULL DEFAULT '',
    name                  TEXT NOT NULL,
    snapshot_id           TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspace_snapshots_repo_id ON workspace_snapshots (repository_id, created_at DESC);
CREATE INDEX idx_workspace_snapshots_workspace_id ON workspace_snapshots (workspace_id);

ALTER TABLE jj_operations
    ADD CONSTRAINT jj_operations_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

-- change_revisions is declared with the jj cache tables, before agent sessions
-- and workspace snapshots exist in the schema snapshot. Attach its provenance
-- foreign keys here once both referenced tables have been declared.
ALTER TABLE issues
    ADD CONSTRAINT issues_fixed_by_agent_session_id_fkey
    FOREIGN KEY (fixed_by_agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT;
ALTER TABLE issues
    ADD CONSTRAINT issues_verified_by_agent_session_id_fkey
    FOREIGN KEY (verified_by_agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT;

ALTER TABLE change_revisions
    ADD CONSTRAINT change_revisions_agent_session_id_fkey
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE change_revisions
    ADD CONSTRAINT change_revisions_workspace_snapshot_id_fkey
    FOREIGN KEY (workspace_snapshot_id) REFERENCES workspace_snapshots(id) ON DELETE SET NULL;
ALTER TABLE change_revisions
    ADD CONSTRAINT change_revisions_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions
    ADD CONSTRAINT agent_sessions_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_agent_session_id_fkey
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_sessions_workspace
    ON agent_sessions (workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE landing_requests
    ADD CONSTRAINT landing_requests_author_agent_session_id_fkey
    FOREIGN KEY (author_agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;

ALTER TABLE landing_request_reviews
    ADD CONSTRAINT landing_request_reviews_agent_session_id_fkey
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;

-- Enforce the lineage FK from workspaces.source_snapshot_id to
-- workspace_snapshots.id that was deferred at table-creation time to avoid
-- a forward reference. ON DELETE SET NULL preserves the workspace row if the
-- snapshot it was derived from is later purged.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspaces_source_snapshot_id_fkey'
    ) THEN
        ALTER TABLE workspaces
            ADD CONSTRAINT workspaces_source_snapshot_id_fkey
            FOREIGN KEY (source_snapshot_id)
            REFERENCES workspace_snapshots(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- import_jobs is declared before workspaces, so attach this FK after the
-- referenced table exists. Incremental migrations add the same constraint
-- directly when upgrading existing databases.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'import_jobs_workspace_id_fkey'
    ) THEN
        ALTER TABLE import_jobs
            ADD CONSTRAINT import_jobs_workspace_id_fkey
            FOREIGN KEY (workspace_id)
            REFERENCES workspaces(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- Workspace terminal sessions: lightweight PTY processes within a workspace
CREATE TABLE IF NOT EXISTS workspace_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ssh_connection_info JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ssh_connection_info) = 'object'),
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'starting', 'running', 'stopped', 'failed')),
    cols              INTEGER NOT NULL DEFAULT 80,
    rows              INTEGER NOT NULL DEFAULT 24,
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs INTEGER NOT NULL DEFAULT 1800,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- LSP relay (#505): 'terminal' (default) or 'lsp'; language is set iff lsp.
    kind              VARCHAR(16) NOT NULL DEFAULT 'terminal',
    language          VARCHAR(32) NOT NULL DEFAULT '',
    CONSTRAINT ck_workspace_sessions_kind CHECK (kind IN ('terminal', 'lsp')),
    CONSTRAINT ck_workspace_sessions_language CHECK ((kind = 'lsp') = (language <> ''))
);

CREATE INDEX idx_workspace_sessions_repo_id ON workspace_sessions (repository_id, created_at DESC);
CREATE INDEX idx_workspace_sessions_user_id ON workspace_sessions (user_id);
CREATE INDEX idx_workspace_sessions_workspace_id ON workspace_sessions (workspace_id);
CREATE INDEX idx_workspace_sessions_status ON workspace_sessions (status) WHERE status IN ('pending', 'starting', 'running');
-- One live language server per workspace and language (#505).
CREATE UNIQUE INDEX idx_workspace_sessions_active_lsp
    ON workspace_sessions (workspace_id, language)
    WHERE kind = 'lsp' AND status IN ('pending', 'starting', 'running');

-- A workspace tombstone and its active session shutdown are a single atomic
-- transition. CreateWorkspaceSession locks the parent workspace first, so a
-- concurrent insert either lands before this trigger runs and is stopped, or
-- observes deleted_at and inserts nothing.
CREATE OR REPLACE FUNCTION stop_workspace_sessions_on_tombstone()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL
       AND (OLD.deleted_at IS NULL OR NEW.status IS DISTINCT FROM OLD.status) THEN
        UPDATE workspace_sessions
        SET status = 'stopped',
            updated_at = NOW()
        WHERE workspace_id = NEW.id
          AND status IN ('pending', 'starting', 'running');
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspaces_stop_sessions_on_tombstone ON workspaces;

CREATE TRIGGER trg_workspaces_stop_sessions_on_tombstone
    AFTER UPDATE OF deleted_at, status ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION stop_workspace_sessions_on_tombstone();

-- Old and new API binaries share this live-parent fence. Locking the parent
-- first serializes session insertion with workspace tombstoning.
CREATE OR REPLACE FUNCTION guard_workspace_session_live_parent_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1
    FROM workspaces
    WHERE id = NEW.workspace_id
      AND repository_id = NEW.repository_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspace_sessions_live_parent_insert ON workspace_sessions;

CREATE TRIGGER trg_workspace_sessions_live_parent_insert
    BEFORE INSERT ON workspace_sessions
    FOR EACH ROW
    EXECUTE FUNCTION guard_workspace_session_live_parent_insert();

-- Prevent a detached previous-version provisioner from resurrecting a
-- session after its workspace was tombstoned. The session row itself
-- serializes this update with the tombstone's AFTER trigger.
CREATE OR REPLACE FUNCTION guard_workspace_session_active_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('pending', 'starting', 'running')
       AND NOT EXISTS (
           SELECT 1
           FROM workspaces
           WHERE id = NEW.workspace_id
             AND deleted_at IS NULL
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspace_sessions_active_status_guard ON workspace_sessions;

CREATE TRIGGER trg_workspace_sessions_active_status_guard
    BEFORE UPDATE OF status ON workspace_sessions
    FOR EACH ROW
    EXECUTE FUNCTION guard_workspace_session_active_status();

-- Workspace sharing grants: allows a workspace owner to explicitly share
-- read or write access to their workspace with another user.
-- level: 'read' (view only) or 'write' (operate: suspend, resume, fork, attach).
-- A row here is a prerequisite for RequireWorkspaceAccess to admit a
-- non-owner requester. There is intentionally no "admin" level — ownership
-- transfer is out of scope for v1.
CREATE TABLE IF NOT EXISTS workspace_shares (
    id            BIGSERIAL PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grantee_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level         VARCHAR(8) NOT NULL DEFAULT 'read'
                  CHECK (level IN ('read', 'write')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, grantee_user_id)
);
CREATE INDEX idx_workspace_shares_grantee ON workspace_shares (grantee_user_id, workspace_id);

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

-- Per-repository environment used to prepare agent workspace VMs. Variables
-- are intentionally nonsecret and remain available after setup. Secret values
-- live in a separate write-only table and are encrypted by the application.
CREATE TABLE IF NOT EXISTS repository_agent_environments (
    repository_id         BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    setup_script          TEXT NOT NULL DEFAULT '',
    environment_variables JSONB NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(environment_variables) = 'array'),
    provider_connection_preference VARCHAR(16) NOT NULL DEFAULT 'org_first'
                          CHECK (provider_connection_preference IN ('org_first', 'user_first', 'org_only', 'user_only', 'platform_only')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repository_agent_environment_secrets (
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,
    -- Egress-proxy binding: when hosts and match_headers are both set the
    -- secret is substituted by the per-sandbox proxy on requests to these
    -- hosts/headers and the guest only ever holds the NAME placeholder. Empty
    -- arrays mean the legacy environment path.
    hosts           TEXT[] NOT NULL DEFAULT '{}',
    match_headers   TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, name)
);

-- Organization secrets (encrypted at rest)
CREATE TABLE IF NOT EXISTS organization_secrets (
    id              BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);
CREATE INDEX idx_organization_secrets_org_id ON organization_secrets (organization_id);

-- Organization variables (plaintext)
CREATE TABLE IF NOT EXISTS organization_variables (
    id              BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);
CREATE INDEX idx_organization_variables_org_id ON organization_variables (organization_id);

-- Audit log (observability Phase 3: "who pushed?")
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    event_type  VARCHAR(64) NOT NULL,
    actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name  VARCHAR(255) NOT NULL DEFAULT '',
    target_type VARCHAR(64) NOT NULL DEFAULT '',
    target_id   BIGINT,
    target_name VARCHAR(255) NOT NULL DEFAULT '',
    action      VARCHAR(32) NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    ip_address  VARCHAR(45) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_log_actor_id ON audit_log (actor_id);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX idx_audit_log_target ON audit_log (target_type, target_id);

-- OAuth2 applications (third-party app authorization)
CREATE TABLE IF NOT EXISTS oauth2_applications (
    id                BIGSERIAL PRIMARY KEY,
    client_id         VARCHAR(64) NOT NULL UNIQUE,
    client_secret_hash VARCHAR(64) NOT NULL,
    name              VARCHAR(255) NOT NULL,
    redirect_uris     TEXT[] NOT NULL DEFAULT '{}'::text[],
    scopes            TEXT[] NOT NULL DEFAULT '{}'::text[],
    owner_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    confidential      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_applications_client_id ON oauth2_applications (client_id);
CREATE INDEX idx_oauth2_applications_owner_id ON oauth2_applications (owner_id);

-- OAuth2 authorization codes (short-lived, single-use)
CREATE TABLE IF NOT EXISTS oauth2_authorization_codes (
    code_hash     VARCHAR(64) NOT NULL UNIQUE,
    app_id        BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes        TEXT[] NOT NULL DEFAULT '{}'::text[],
    redirect_uri  TEXT NOT NULL,
    code_challenge TEXT NOT NULL DEFAULT '',
    code_challenge_method VARCHAR(16) NOT NULL DEFAULT '',
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_authorization_codes_app_id ON oauth2_authorization_codes (app_id);
CREATE INDEX idx_oauth2_authorization_codes_expires_at ON oauth2_authorization_codes (expires_at);

-- OAuth2 access tokens (issued to third-party apps)
CREATE TABLE IF NOT EXISTS oauth2_access_tokens (
    id            BIGSERIAL PRIMARY KEY,
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    app_id        BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes        TEXT[] NOT NULL DEFAULT '{}'::text[],
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_access_tokens_token_hash ON oauth2_access_tokens (token_hash);
CREATE INDEX idx_oauth2_access_tokens_app_id ON oauth2_access_tokens (app_id);
CREATE INDEX idx_oauth2_access_tokens_user_id ON oauth2_access_tokens (user_id);
CREATE INDEX idx_oauth2_access_tokens_expires_at ON oauth2_access_tokens (expires_at);

-- OAuth2 refresh tokens (long-lived, rotatable)
CREATE TABLE IF NOT EXISTS oauth2_refresh_tokens (
    id            BIGSERIAL PRIMARY KEY,
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    app_id        BIGINT NOT NULL REFERENCES oauth2_applications(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes        TEXT[],
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth2_refresh_tokens_token_hash ON oauth2_refresh_tokens (token_hash);
CREATE INDEX idx_oauth2_refresh_tokens_app_id ON oauth2_refresh_tokens (app_id);
CREATE INDEX idx_oauth2_refresh_tokens_user_id ON oauth2_refresh_tokens (user_id);
CREATE INDEX idx_oauth2_refresh_tokens_expires_at ON oauth2_refresh_tokens (expires_at);

-- Workflow caches (dependency caching between workflow runs)
CREATE TABLE IF NOT EXISTS workflow_caches (
    id                BIGSERIAL PRIMARY KEY,
    repository_id     BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_run_id   BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    bookmark_name     VARCHAR(255) NOT NULL,
    cache_key         VARCHAR(512) NOT NULL,
    cache_version     VARCHAR(64) NOT NULL DEFAULT 'static',
    object_key        TEXT NOT NULL,
    object_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (object_size_bytes >= 0),
    compression       VARCHAR(32) NOT NULL DEFAULT 'tar+gzip',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'finalized', 'deleting')),
    deletion_token    VARCHAR(64),
    hit_count         BIGINT NOT NULL DEFAULT 0,
    last_hit_at       TIMESTAMPTZ,
    finalized_at      TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workflow_caches_deletion_state_check
        CHECK (status = 'deleting' OR deletion_token IS NULL),
    UNIQUE (repository_id, bookmark_name, cache_key, cache_version)
);

CREATE INDEX idx_workflow_caches_repo_id ON workflow_caches (repository_id);
CREATE INDEX idx_workflow_caches_restore_lookup ON workflow_caches (
    repository_id,
    bookmark_name,
    cache_key,
    cache_version,
    status,
    expires_at DESC
);
CREATE INDEX idx_workflow_caches_eviction ON workflow_caches (
    repository_id,
    status,
    expires_at,
    last_hit_at,
    finalized_at,
    updated_at,
    created_at
);

-- Workflow artifacts (build outputs shared between steps and runs)
CREATE TABLE IF NOT EXISTS workflow_artifacts (
    id                  BIGSERIAL PRIMARY KEY,
    repository_id       BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    size                BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    content_type        VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    status              VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleting')),
    gcs_key             TEXT NOT NULL,
    confirmed_at        TIMESTAMPTZ,
    deletion_token      VARCHAR(64),
    expires_at          TIMESTAMPTZ NOT NULL,
    release_tag         TEXT,
    release_asset_name  TEXT,
    release_attached_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workflow_artifacts_deletion_state_check
        CHECK (status = 'deleting' OR deletion_token IS NULL),
    UNIQUE (workflow_run_id, name)
);

CREATE INDEX idx_workflow_artifacts_repo_id ON workflow_artifacts (repository_id, created_at DESC);
CREATE INDEX idx_workflow_artifacts_run_id ON workflow_artifacts (workflow_run_id, created_at DESC);
CREATE INDEX idx_workflow_artifacts_expires_at ON workflow_artifacts (expires_at);
CREATE INDEX idx_workflow_artifacts_cleanup ON workflow_artifacts (status, created_at, expires_at, updated_at, id);
CREATE INDEX idx_workflow_artifacts_deleting_retry ON workflow_artifacts (updated_at, id) WHERE status = 'deleting';

-- Releases (tags with metadata and uploaded assets)
CREATE TABLE IF NOT EXISTS releases (
    id            BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    publisher_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag_name      VARCHAR(255) NOT NULL,
    target        VARCHAR(255) NOT NULL DEFAULT '',
    title         VARCHAR(255) NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    sha           VARCHAR(255) NOT NULL DEFAULT '',
    is_draft      BOOLEAN NOT NULL DEFAULT FALSE,
    is_prerelease BOOLEAN NOT NULL DEFAULT FALSE,
    is_tag        BOOLEAN NOT NULL DEFAULT FALSE,
    published_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, tag_name)
);

CREATE INDEX idx_releases_repo_id ON releases (repository_id, (COALESCE(published_at, created_at)) DESC, id DESC);
CREATE INDEX idx_releases_tag_name ON releases (repository_id, tag_name);

CREATE TABLE IF NOT EXISTS release_assets (
    id             BIGSERIAL PRIMARY KEY,
    release_id     BIGINT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    uploader_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    size           BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    download_count BIGINT NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    status         VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleting')),
    gcs_key        TEXT NOT NULL,
    content_type   VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    confirmed_at   TIMESTAMPTZ,
    deletion_token VARCHAR(64),
    delete_after   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT release_assets_deletion_state_check
        CHECK (
            (status = 'deleting' AND delete_after IS NOT NULL)
            OR (
                status <> 'deleting'
                AND deletion_token IS NULL
                AND delete_after IS NULL
            )
        )
);

CREATE INDEX idx_release_assets_release_id ON release_assets (release_id, created_at DESC);
CREATE INDEX idx_release_assets_cleanup ON release_assets (status, delete_after, created_at, updated_at, id);
CREATE INDEX idx_release_assets_deleting_retry ON release_assets (updated_at, id) WHERE status = 'deleting';
CREATE UNIQUE INDEX uq_release_assets_live_name ON release_assets (release_id, name) WHERE status <> 'deleting';

CREATE TABLE IF NOT EXISTS release_deletion_intents (
    release_id     BIGINT PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
    deletion_token VARCHAR(64),
    event_dispatched_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_release_deletion_intents_retry ON release_deletion_intents (updated_at, release_id);

CREATE TABLE IF NOT EXISTS release_deletion_tag_tombstones (
    release_id        BIGINT PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
    original_tag_name VARCHAR(255) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION tombstone_release_tag_on_deletion_intent()
RETURNS TRIGGER AS $$
DECLARE
    v_current_tag VARCHAR(255);
    v_tombstone_tag VARCHAR(255) := CHR(31) || 'smithers-deleted-release:' || NEW.release_id::text;
BEGIN
    SELECT tag_name
    INTO v_current_tag
    FROM releases
    WHERE id = NEW.release_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_current_tag <> v_tombstone_tag THEN
        INSERT INTO release_deletion_tag_tombstones (release_id, original_tag_name)
        VALUES (NEW.release_id, v_current_tag)
        ON CONFLICT (release_id) DO NOTHING;
    END IF;

    IF v_current_tag <> v_tombstone_tag THEN
        UPDATE releases
        SET tag_name = v_tombstone_tag
        WHERE id = NEW.release_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_release_deletion_intents_tombstone_tag
    BEFORE INSERT ON release_deletion_intents
    FOR EACH ROW
    EXECUTE FUNCTION tombstone_release_tag_on_deletion_intent();

CREATE OR REPLACE FUNCTION guard_release_deletion_tombstone()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM release_deletion_intents
        WHERE release_id = OLD.id
    ) THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_releases_guard_deletion_tombstone
    BEFORE UPDATE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION guard_release_deletion_tombstone();

-- Stripe-backed billing projection
CREATE TABLE IF NOT EXISTS billing_accounts (
    id                    BIGSERIAL PRIMARY KEY,
    owner_type            VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id              BIGINT NOT NULL,
    stripe_customer_id    VARCHAR(255) NOT NULL UNIQUE,
    stripe_customer_email VARCHAR(255) NOT NULL DEFAULT '',
    stripe_customer_name  VARCHAR(255) NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_type, owner_id)
);

CREATE INDEX idx_billing_accounts_owner
    ON billing_accounts (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                     BIGSERIAL PRIMARY KEY,
    billing_account_id     BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    stripe_subscription_id VARCHAR(255) NOT NULL UNIQUE,
    stripe_price_id        VARCHAR(255) NOT NULL DEFAULT '',
    plan_key               VARCHAR(64) NOT NULL DEFAULT '',
    billing_interval       VARCHAR(16) NOT NULL DEFAULT '' CHECK (billing_interval IN ('', 'monthly', 'annual')),
    status                 VARCHAR(32) NOT NULL,
    quantity               BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    trial_end              TIMESTAMPTZ,
    current_period_start   TIMESTAMPTZ,
    current_period_end     TIMESTAMPTZ,
    past_due_since         TIMESTAMPTZ,
    cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
    canceled_at            TIMESTAMPTZ,
    raw_payload            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_subscriptions_account_updated
    ON billing_subscriptions (billing_account_id, updated_at DESC);

CREATE INDEX idx_billing_subscriptions_account_status
    ON billing_subscriptions (billing_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS billing_entitlements (
    id                 BIGSERIAL PRIMARY KEY,
    billing_account_id BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    feature_key        VARCHAR(255) NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (billing_account_id, feature_key)
);

CREATE INDEX idx_billing_entitlements_account_active
    ON billing_entitlements (billing_account_id, active);

CREATE TABLE IF NOT EXISTS billing_usage_counters (
    id                           BIGSERIAL PRIMARY KEY,
    owner_type                   VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id                     BIGINT NOT NULL,
    metric_key                   VARCHAR(64) NOT NULL,
    period_start                 TIMESTAMPTZ NOT NULL,
    period_end                   TIMESTAMPTZ NOT NULL,
    included_quantity            BIGINT NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
    consumed_quantity            BIGINT NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
    overage_quantity             BIGINT NOT NULL DEFAULT 0 CHECK (overage_quantity >= 0),
    last_reported_meter_event_id VARCHAR(255) NOT NULL DEFAULT '',
    last_synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (period_end > period_start),
    UNIQUE (owner_type, owner_id, metric_key, period_start, period_end)
);

CREATE INDEX idx_billing_usage_counters_owner_metric_period
    ON billing_usage_counters (owner_type, owner_id, metric_key, period_start DESC);

-- Credit ledger: append-only log of all credit transactions (grants, deductions, purchases, expirations)
CREATE TABLE IF NOT EXISTS billing_credit_ledger (
    id                  BIGSERIAL PRIMARY KEY,
    billing_account_id  BIGINT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    amount_cents        BIGINT NOT NULL,                                         -- positive = credit added, negative = credit consumed
    balance_after_cents BIGINT NOT NULL,                                         -- running balance after this entry
    reason              VARCHAR(255) NOT NULL DEFAULT '',                         -- human-readable reason
    category            VARCHAR(32) NOT NULL CHECK (category IN (
                            'monthly_grant', 'purchase', 'deduction', 'refund', 'gift', 'expiration', 'adjustment'
                        )),
    metric_key          VARCHAR(64) NOT NULL DEFAULT '',                          -- which metered resource (empty for grants/purchases)
    idempotency_key     VARCHAR(255) NOT NULL DEFAULT '',                         -- prevent duplicate entries
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_credit_ledger_account
    ON billing_credit_ledger (billing_account_id, created_at DESC);

CREATE UNIQUE INDEX uq_billing_credit_ledger_idempotency
    ON billing_credit_ledger (billing_account_id, idempotency_key)
    WHERE idempotency_key != '';

-- Materialized credit balance per account (updated via ledger inserts)
CREATE TABLE IF NOT EXISTS billing_credit_balances (
    billing_account_id  BIGINT PRIMARY KEY REFERENCES billing_accounts(id) ON DELETE CASCADE,
    balance_cents       BIGINT NOT NULL DEFAULT 0,
    last_grant_at       TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_processed_events (
    event_id     VARCHAR(255) PRIMARY KEY,
    event_type   VARCHAR(255) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stripe_processed_events_processed_at
    ON stripe_processed_events (processed_at DESC);

-- Linear integration (per-user Linear connection + repo mapping)
CREATE TABLE IF NOT EXISTS linear_integrations (
    id                       BIGSERIAL PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id                   BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    linear_team_id           VARCHAR(255) NOT NULL,
    linear_team_name         VARCHAR(255) NOT NULL DEFAULT '',
    linear_team_key          VARCHAR(32) NOT NULL DEFAULT '',
    access_token_encrypted   BYTEA NOT NULL,
    refresh_token_encrypted  BYTEA,
    token_expires_at         TIMESTAMPTZ,
    webhook_key              VARCHAR(64) NOT NULL DEFAULT '',
    webhook_secret           VARCHAR(255) NOT NULL,
    jjhub_repo_id            BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    jjhub_repo_owner         VARCHAR(255) NOT NULL,
    jjhub_repo_name          VARCHAR(255) NOT NULL,
    linear_actor_id          VARCHAR(255) NOT NULL DEFAULT '',
    linear_actor_name        VARCHAR(255) NOT NULL DEFAULT '',
    linear_actor_email       VARCHAR(320) NOT NULL DEFAULT '',
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    last_sync_at             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, linear_team_id, jjhub_repo_id)
);

CREATE UNIQUE INDEX idx_linear_integrations_webhook_key ON linear_integrations (webhook_key) WHERE webhook_key <> '';
CREATE INDEX idx_linear_integrations_user_id ON linear_integrations (user_id);
CREATE INDEX idx_linear_integrations_repo_id ON linear_integrations (jjhub_repo_id);
CREATE INDEX idx_linear_integrations_team_id ON linear_integrations (linear_team_id);
CREATE INDEX idx_linear_integrations_active ON linear_integrations (is_active) WHERE is_active = TRUE;

-- Linear issue mapping (Smithers issue ↔ Linear issue)
CREATE TABLE IF NOT EXISTS linear_issue_map (
    id                  BIGSERIAL PRIMARY KEY,
    integration_id      BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    jjhub_issue_id      BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    jjhub_issue_number  BIGINT NOT NULL,
    linear_issue_id     VARCHAR(255) NOT NULL,
    linear_identifier   VARCHAR(64) NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (integration_id, jjhub_issue_id),
    UNIQUE (integration_id, linear_issue_id)
);

CREATE INDEX idx_linear_issue_map_integration ON linear_issue_map (integration_id);
CREATE INDEX idx_linear_issue_map_jjhub_issue ON linear_issue_map (jjhub_issue_id);
CREATE INDEX idx_linear_issue_map_linear_issue ON linear_issue_map (linear_issue_id);

-- Linear comment mapping
CREATE TABLE IF NOT EXISTS linear_comment_map (
    id                  BIGSERIAL PRIMARY KEY,
    issue_map_id        BIGINT NOT NULL REFERENCES linear_issue_map(id) ON DELETE CASCADE,
    jjhub_comment_id    BIGINT NOT NULL,
    linear_comment_id   VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issue_map_id, jjhub_comment_id),
    UNIQUE (issue_map_id, linear_comment_id)
);

CREATE INDEX idx_linear_comment_map_issue_map ON linear_comment_map (issue_map_id);

-- Durable Linear sync runs used by the live sync progress card.
CREATE TABLE IF NOT EXISTS linear_sync_runs (
    id               BIGSERIAL PRIMARY KEY,
    integration_id   BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    state            VARCHAR(16) NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'running', 'completed', 'failed')),
    issues_done      INTEGER NOT NULL DEFAULT 0 CHECK (issues_done >= 0),
    issues_total     INTEGER NOT NULL DEFAULT 0 CHECK (issues_total >= 0),
    issues_failed    INTEGER NOT NULL DEFAULT 0 CHECK (issues_failed >= 0),
    comments_done    INTEGER NOT NULL DEFAULT 0 CHECK (comments_done >= 0),
    comments_total   INTEGER NOT NULL DEFAULT 0 CHECK (comments_total >= 0),
    comments_failed  INTEGER NOT NULL DEFAULT 0 CHECK (comments_failed >= 0),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_linear_sync_runs_integration
    ON linear_sync_runs (integration_id, created_at DESC, id DESC);

-- Linear sync operations (audit log + loop guard temporal dedup)
CREATE TABLE IF NOT EXISTS linear_sync_ops (
    id              BIGSERIAL PRIMARY KEY,
    integration_id  BIGINT NOT NULL REFERENCES linear_integrations(id) ON DELETE CASCADE,
    run_id          BIGINT REFERENCES linear_sync_runs(id) ON DELETE SET NULL,
    retry_of_id     BIGINT REFERENCES linear_sync_ops(id) ON DELETE SET NULL,
    source          VARCHAR(16) NOT NULL CHECK (source IN ('jjhub', 'linear')),
    target          VARCHAR(16) NOT NULL CHECK (target IN ('jjhub', 'linear')),
    entity          VARCHAR(32) NOT NULL CHECK (entity IN ('issue', 'comment')),
    entity_id       VARCHAR(255) NOT NULL,
    action          VARCHAR(32) NOT NULL CHECK (action IN ('create', 'update', 'delete', 'close', 'reopen', 'initial_sync')),
    status          VARCHAR(16) NOT NULL DEFAULT 'success' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
    error_message   TEXT NOT NULL DEFAULT '',
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_linear_sync_ops_integration ON linear_sync_ops (integration_id, created_at DESC);
CREATE INDEX idx_linear_sync_ops_feed ON linear_sync_ops (integration_id, created_at DESC, id DESC);
CREATE INDEX idx_linear_sync_ops_dedup ON linear_sync_ops (integration_id, entity, entity_id, created_at DESC);
CREATE INDEX idx_linear_sync_ops_run ON linear_sync_ops (run_id, created_at DESC, id DESC) WHERE run_id IS NOT NULL;
CREATE INDEX idx_linear_sync_ops_retry_of ON linear_sync_ops (retry_of_id) WHERE retry_of_id IS NOT NULL;

-- Persisted production canary results (e.g. Playwright UI canaries)
CREATE TABLE IF NOT EXISTS canary_results (
    id                BIGSERIAL PRIMARY KEY,
    suite             VARCHAR(32) NOT NULL,
    test_name         VARCHAR(128) NOT NULL,
    status            VARCHAR(16) NOT NULL CHECK (status IN ('success', 'failure')),
    duration_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
    error_message     TEXT NOT NULL DEFAULT '',
    run_id            VARCHAR(128) NOT NULL DEFAULT '',
    reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (suite, test_name)
);

CREATE INDEX idx_canary_results_suite_reported
    ON canary_results (suite, reported_at DESC);

-- SSE tickets (short-lived, single-use tokens for EventSource connections)
CREATE TABLE IF NOT EXISTS sse_tickets (
    ticket_hash  VARCHAR(64) PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ
);

CREATE INDEX idx_sse_tickets_expires_at ON sse_tickets (expires_at);
CREATE INDEX idx_sse_tickets_user_id ON sse_tickets (user_id);

-- Issue artifacts (research, plans, review logs attached to issues)
CREATE TABLE IF NOT EXISTS issue_artifacts (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_id        BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    step_name       VARCHAR(255) NOT NULL DEFAULT '',
    size            BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    content_type    VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    status          VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleting')),
    gcs_key         TEXT NOT NULL,
    confirmed_at    TIMESTAMPTZ,
    deletion_token  VARCHAR(64),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT issue_artifacts_deletion_state_check
        CHECK (status = 'deleting' OR deletion_token IS NULL),
    UNIQUE (issue_id, name)
);

CREATE INDEX idx_issue_artifacts_repo_id ON issue_artifacts (repository_id, created_at DESC);
CREATE INDEX idx_issue_artifacts_issue_id ON issue_artifacts (issue_id, created_at DESC);
CREATE INDEX idx_issue_artifacts_expires_at ON issue_artifacts (expires_at);
CREATE INDEX idx_issue_artifacts_cleanup ON issue_artifacts (status, created_at, expires_at, updated_at, id);

-- Once deletion has started, previous-version upload confirmers may not
-- restore a released claim to ready. Retry workers may still rotate only the
-- lease token and updated_at while exact-key cleanup remains recoverable.
CREATE OR REPLACE FUNCTION guard_artifact_deletion_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'deleting'
       AND (
           NEW.status IS DISTINCT FROM 'deleting'
           OR (to_jsonb(NEW) - 'deletion_token' - 'updated_at')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'deletion_token' - 'updated_at')
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_artifacts_guard_deletion_claim
    BEFORE UPDATE ON workflow_artifacts
    FOR EACH ROW EXECUTE FUNCTION guard_artifact_deletion_claim();

CREATE TRIGGER trg_issue_artifacts_guard_deletion_claim
    BEFORE UPDATE ON issue_artifacts
    FOR EACH ROW EXECUTE FUNCTION guard_artifact_deletion_claim();

CREATE OR REPLACE FUNCTION guard_storage_legacy_capability_horizon()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'storage legacy capability horizon cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.capability_kind IS DISTINCT FROM OLD.capability_kind THEN
        RAISE EXCEPTION 'storage legacy capability kind is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT isfinite(NEW.valid_until) OR NEW.valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'legacy capability horizon must be a finite future timestamp'
            USING ERRCODE = 'check_violation';
    END IF;
    IF isfinite(OLD.valid_until) AND OLD.valid_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'legacy capability horizon cannot change after purge has opened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF isfinite(OLD.valid_until) AND NEW.valid_until < OLD.valid_until THEN
        RAISE EXCEPTION 'legacy capability horizon can only be extended'
            USING ERRCODE = 'check_violation';
    END IF;
    IF BTRIM(COALESCE(NEW.attested_by, '')) = ''
       OR BTRIM(COALESCE(NEW.attestation, '')) = '' THEN
        RAISE EXCEPTION 'legacy capability horizon requires operator and evidence'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.attested_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_storage_legacy_capability_horizon_guard
    BEFORE UPDATE OR DELETE ON storage_legacy_capability_horizons
    FOR EACH ROW EXECUTE FUNCTION guard_storage_legacy_capability_horizon();

-- Staging classification requires a distinct final key for the same durable
-- allocation. Ambiguous legacy/custom names therefore remain final and inherit
-- the fail-closed capability horizon.
CREATE OR REPLACE FUNCTION is_storage_staging_deletion_key(
    p_repository_id BIGINT,
    p_allocation_key TEXT,
    p_object_key TEXT
)
RETURNS BOOLEAN AS $$
    SELECT CASE
        WHEN p_allocation_key LIKE 'lfs:%' THEN
            p_object_key = format(
                'lfs-pending/%s/%s',
                split_part(p_allocation_key, ':', 2),
                split_part(p_allocation_key, ':', 3)
            )
            AND split_part(p_allocation_key, ':', 4) = ''
            AND EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
            )
        WHEN p_allocation_key LIKE 'workflow-cache:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/workflow-caches/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'workflow-artifact:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/workflow-artifacts/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'issue-artifact:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/issue-artifacts/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        WHEN p_allocation_key LIKE 'release-asset:%' THEN
            EXISTS (
                SELECT 1
                FROM storage_deletion_queue AS sibling
                WHERE sibling.repository_id = p_repository_id
                  AND sibling.allocation_key = p_allocation_key
                  AND sibling.object_key <> p_object_key
                  AND p_object_key = format(
                      'pending/release-assets/%s', LTRIM(sibling.object_key, '/')
                  )
            )
        ELSE FALSE
    END;
$$ LANGUAGE sql STABLE;

-- Queue insertion centralizes exact-key idempotency and resets stale claims
-- whenever a concurrent metadata deletion proves the key still needs cleanup.
CREATE OR REPLACE FUNCTION enqueue_storage_deletion(
    p_repository_id BIGINT,
    p_owner_type TEXT,
    p_owner_id BIGINT,
    p_allocation_key TEXT,
    p_object_key TEXT,
    p_size_bytes BIGINT,
    p_delete_after TIMESTAMPTZ
)
RETURNS VOID AS $$
DECLARE
    v_requested_delete_after TIMESTAMPTZ;
    v_horizon TIMESTAMPTZ;
    v_is_staging BOOLEAN;
BEGIN
    IF p_repository_id IS NULL
        OR p_owner_type NOT IN ('user', 'org')
        OR p_owner_id IS NULL
        OR BTRIM(COALESCE(p_allocation_key, '')) = ''
        OR BTRIM(COALESCE(p_object_key, '')) = ''
    THEN
        RETURN;
    END IF;

    v_requested_delete_after := GREATEST(COALESCE(p_delete_after, NOW()), NOW());
    v_is_staging := is_storage_staging_deletion_key(
        p_repository_id, p_allocation_key, p_object_key
    );
    v_horizon := COALESCE(
        (
            SELECT horizon.valid_until
            FROM storage_legacy_capability_horizons AS horizon
            WHERE horizon.capability_kind = 'legacy-final-key-upload'
        ),
        'infinity'::timestamptz
    );

    INSERT INTO storage_deletion_queue (
        repository_id, owner_type, owner_id, allocation_key, object_key,
        size_bytes, delete_after, requested_delete_after
    ) VALUES (
        p_repository_id, p_owner_type, p_owner_id, p_allocation_key,
        p_object_key, GREATEST(COALESCE(p_size_bytes, 0), 0),
        CASE
            WHEN v_is_staging THEN v_requested_delete_after
            WHEN isfinite(v_horizon) THEN GREATEST(v_requested_delete_after, v_horizon)
            ELSE TIMESTAMPTZ '9999-12-31 23:59:59+00'
        END,
        CASE WHEN v_is_staging THEN NULL ELSE v_requested_delete_after END
    )
    ON CONFLICT (object_key) DO UPDATE
    SET repository_id = EXCLUDED.repository_id,
        owner_type = EXCLUDED.owner_type,
        owner_id = EXCLUDED.owner_id,
        allocation_key = EXCLUDED.allocation_key,
        size_bytes = GREATEST(storage_deletion_queue.size_bytes, EXCLUDED.size_bytes),
        delete_after = GREATEST(storage_deletion_queue.delete_after, EXCLUDED.delete_after),
        requested_delete_after = GREATEST(
            storage_deletion_queue.requested_delete_after,
            EXCLUDED.requested_delete_after
        ),
        claim_token = NULL,
        claimed_at = NULL,
        last_error = NULL,
        updated_at = NOW();

    UPDATE storage_deletion_queue AS queue
    SET delete_after = queue.requested_delete_after,
        requested_delete_after = NULL,
        updated_at = NOW()
    WHERE queue.repository_id = p_repository_id
      AND queue.allocation_key = p_allocation_key
      AND queue.requested_delete_after IS NOT NULL
      AND is_storage_staging_deletion_key(
          queue.repository_id, queue.allocation_key, queue.object_key
      );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_repository_storage_deletions()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_type TEXT := CASE WHEN OLD.user_id IS NOT NULL THEN 'user' ELSE 'org' END;
    v_owner_id BIGINT := COALESCE(OLD.user_id, OLD.org_id);
    v_row RECORD;
BEGIN
    PERFORM set_config(
        'smithers.deleting_repository_ids',
        COALESCE(NULLIF(current_setting('smithers.deleting_repository_ids', TRUE), ''), ',')
            || OLD.id::text || ',',
        TRUE
    );

    FOR v_row IN
        SELECT oid, size, gcs_path FROM lfs_objects WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid), v_row.gcs_path,
            v_row.size, NOW());
        -- Registered LFS objects can receive repair URLs long after creation.
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('lfs-pending/%s/%s', OLD.id, v_row.oid), v_row.size,
            NOW() + INTERVAL '7 days 15 minutes');
    END LOOP;

    FOR v_row IN
        SELECT oid, size, expires_at
        FROM lfs_upload_reservations WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('lfs-pending/%s/%s', OLD.id, v_row.oid), v_row.size,
            GREATEST(NOW(), v_row.expires_at));
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('lfs:%s:%s', OLD.id, v_row.oid),
            format('repos/%s/lfs/%s', OLD.id, v_row.oid), v_row.size, NOW());
    END LOOP;

    FOR v_row IN
        SELECT object_key, object_size_bytes, status, expires_at,
               finalized_at, created_at
        FROM workflow_caches WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-cache:%s:%s', OLD.id, v_row.object_key),
            v_row.object_key, v_row.object_size_bytes, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-cache:%s:%s', OLD.id, v_row.object_key),
            format('pending/workflow-caches/%s', LTRIM(v_row.object_key, '/')),
            v_row.object_size_bytes,
            GREATEST(NOW(), CASE
                WHEN v_row.finalized_at IS NULL THEN v_row.expires_at
                ELSE v_row.finalized_at + INTERVAL '7 days 15 minutes'
            END));
    END LOOP;

    FOR v_row IN
        SELECT id, gcs_key, size, created_at
        FROM workflow_artifacts WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-artifact:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('workflow-artifact:%s', v_row.id),
            format('pending/workflow-artifacts/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;

    FOR v_row IN
        SELECT id, gcs_key, size, created_at
        FROM issue_artifacts WHERE repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('issue-artifact:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('issue-artifact:%s', v_row.id),
            format('pending/issue-artifacts/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;

    FOR v_row IN
        SELECT ra.id, ra.gcs_key, ra.size, ra.created_at
        FROM release_assets AS ra
        JOIN releases AS rel ON rel.id = ra.release_id
        WHERE rel.repository_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('release-asset:%s', v_row.id), v_row.gcs_key,
            v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.id, v_owner_type, v_owner_id,
            format('release-asset:%s', v_row.id),
            format('pending/release-assets/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_lfs_object_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1 FROM lfs_upload_reservations
            WHERE repository_id = OLD.repository_id AND oid = OLD.oid
        ) THEN
            DELETE FROM storage_deletion_queue
            WHERE object_key IN (
                OLD.gcs_path,
                format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid)
            );
            RETURN OLD;
        END IF;
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            OLD.gcs_path, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid), OLD.size,
            NOW() + INTERVAL '7 days 15 minutes');
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_lfs_reservation_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        IF POSITION(
            ',' || OLD.repository_id::text || ',' IN
            COALESCE(current_setting('smithers.deleting_repository_ids', TRUE), '')
        ) = 0 AND TG_OP = 'DELETE' AND EXISTS (
            SELECT 1 FROM lfs_objects
            WHERE repository_id = OLD.repository_id AND oid = OLD.oid
        ) THEN
            DELETE FROM storage_deletion_queue
            WHERE object_key IN (
                format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid),
                format('repos/%s/lfs/%s', OLD.repository_id, OLD.oid)
            );
            RETURN OLD;
        END IF;
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('lfs-pending/%s/%s', OLD.repository_id, OLD.oid), OLD.size,
            GREATEST(NOW(), OLD.expires_at));
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('lfs:%s:%s', OLD.repository_id, OLD.oid),
            format('repos/%s/lfs/%s', OLD.repository_id, OLD.oid), OLD.size,
            NOW());
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_workflow_cache_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-cache:%s:%s', OLD.repository_id, OLD.object_key),
            OLD.object_key, OLD.object_size_bytes, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-cache:%s:%s', OLD.repository_id, OLD.object_key),
            format('pending/workflow-caches/%s', LTRIM(OLD.object_key, '/')),
            OLD.object_size_bytes,
            GREATEST(NOW(), CASE
                WHEN OLD.finalized_at IS NULL THEN OLD.expires_at
                ELSE OLD.finalized_at + INTERVAL '7 days 15 minutes'
            END));
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_workflow_artifact_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-artifact:%s', OLD.id), OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('workflow-artifact:%s', OLD.id),
            format('pending/workflow-artifacts/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_issue_artifact_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repo repositories%ROWTYPE;
BEGIN
    SELECT * INTO v_repo FROM repositories WHERE id = OLD.repository_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('issue-artifact:%s', OLD.id), OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_repo.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_repo.user_id, v_repo.org_id),
            format('issue-artifact:%s', OLD.id),
            format('pending/issue-artifacts/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_release_asset_storage_deletion()
RETURNS TRIGGER AS $$
DECLARE
    v_repository_id BIGINT;
    v_user_id BIGINT;
    v_org_id BIGINT;
BEGIN
    SELECT rel.repository_id, repo.user_id, repo.org_id
    INTO v_repository_id, v_user_id, v_org_id
    FROM releases AS rel
    JOIN repositories AS repo ON repo.id = rel.repository_id
    WHERE rel.id = OLD.release_id;
    IF FOUND THEN
        PERFORM enqueue_storage_deletion(v_repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', OLD.id),
            OLD.gcs_key, OLD.size, NOW());
        PERFORM enqueue_storage_deletion(v_repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', OLD.id),
            format('pending/release-assets/%s', LTRIM(OLD.gcs_key, '/')),
            OLD.size, GREATEST(NOW(), OLD.created_at + INTERVAL '7 days 15 minutes'));
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_release_storage_deletions()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id BIGINT;
    v_org_id BIGINT;
    v_row RECORD;
BEGIN
    SELECT user_id, org_id INTO v_user_id, v_org_id
    FROM repositories WHERE id = OLD.repository_id;
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;
    FOR v_row IN
        SELECT id, gcs_key, size, created_at
        FROM release_assets WHERE release_id = OLD.id
    LOOP
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', v_row.id),
            v_row.gcs_key, v_row.size, NOW());
        PERFORM enqueue_storage_deletion(OLD.repository_id,
            CASE WHEN v_user_id IS NOT NULL THEN 'user' ELSE 'org' END,
            COALESCE(v_user_id, v_org_id), format('release-asset:%s', v_row.id),
            format('pending/release-assets/%s', LTRIM(v_row.gcs_key, '/')),
            v_row.size,
            GREATEST(NOW(), v_row.created_at + INTERVAL '7 days 15 minutes'));
    END LOOP;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resolve_recreated_lfs_storage_keys()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'lfs_objects' THEN
        DELETE FROM storage_deletion_queue
        WHERE object_key IN (
            NEW.gcs_path,
            format('lfs-pending/%s/%s', NEW.repository_id, NEW.oid)
        );
    ELSE
        DELETE FROM storage_deletion_queue
        WHERE object_key IN (
            format('lfs-pending/%s/%s', NEW.repository_id, NEW.oid),
            format('repos/%s/lfs/%s', NEW.repository_id, NEW.oid)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retarget_repository_storage_deletions()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE storage_deletion_queue
    SET owner_type = CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'org' END,
        owner_id = COALESCE(NEW.user_id, NEW.org_id),
        updated_at = NOW()
    WHERE repository_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_enqueue_storage_deletions
    BEFORE DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION enqueue_repository_storage_deletions();
CREATE TRIGGER trg_repositories_retarget_storage_deletions
    AFTER UPDATE OF user_id, org_id ON repositories
    FOR EACH ROW
    WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.org_id IS DISTINCT FROM NEW.org_id)
    EXECUTE FUNCTION retarget_repository_storage_deletions();
CREATE TRIGGER trg_lfs_objects_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF repository_id, oid, gcs_path ON lfs_objects
    FOR EACH ROW EXECUTE FUNCTION enqueue_lfs_object_storage_deletion();
CREATE TRIGGER trg_lfs_reservations_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF repository_id, oid ON lfs_upload_reservations
    FOR EACH ROW EXECUTE FUNCTION enqueue_lfs_reservation_storage_deletion();
CREATE TRIGGER trg_workflow_caches_enqueue_storage_deletion
    BEFORE DELETE OR UPDATE OF object_key ON workflow_caches
    FOR EACH ROW EXECUTE FUNCTION enqueue_workflow_cache_storage_deletion();
CREATE TRIGGER trg_workflow_artifacts_enqueue_storage_deletion
    BEFORE DELETE ON workflow_artifacts
    FOR EACH ROW EXECUTE FUNCTION enqueue_workflow_artifact_storage_deletion();
CREATE TRIGGER trg_issue_artifacts_enqueue_storage_deletion
    BEFORE DELETE ON issue_artifacts
    FOR EACH ROW EXECUTE FUNCTION enqueue_issue_artifact_storage_deletion();
CREATE TRIGGER trg_release_assets_enqueue_storage_deletion
    BEFORE DELETE ON release_assets
    FOR EACH ROW EXECUTE FUNCTION enqueue_release_asset_storage_deletion();
CREATE TRIGGER trg_releases_enqueue_storage_deletions
    BEFORE DELETE ON releases
    FOR EACH ROW EXECUTE FUNCTION enqueue_release_storage_deletions();
CREATE TRIGGER trg_lfs_objects_resolve_recreated_storage_keys
    BEFORE INSERT OR UPDATE OF repository_id, oid, gcs_path ON lfs_objects
    FOR EACH ROW EXECUTE FUNCTION resolve_recreated_lfs_storage_keys();
CREATE TRIGGER trg_lfs_reservations_resolve_recreated_storage_keys
    BEFORE INSERT OR UPDATE OF repository_id, oid ON lfs_upload_reservations
    FOR EACH ROW EXECUTE FUNCTION resolve_recreated_lfs_storage_keys();

-- Sandbox access tokens for SSH/terminal/preview
CREATE TABLE IF NOT EXISTS sandbox_access_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID REFERENCES workspaces(id),
    vm_id           TEXT NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    linux_user      TEXT NOT NULL,
    token_hash      BYTEA NOT NULL,
    token_type      TEXT NOT NULL CHECK (token_type IN ('ssh', 'terminal')),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_access_tokens_vm_id ON sandbox_access_tokens (vm_id);
CREATE INDEX idx_sandbox_access_tokens_expires_at ON sandbox_access_tokens (expires_at);

-- Sync queue for local-first daemon mode
CREATE TABLE IF NOT EXISTS _sync_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    method VARCHAR(8) NOT NULL,
    path TEXT NOT NULL,
    body JSONB,
    local_id TEXT,
    remote_id TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'conflict', 'failed')),
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ
);

CREATE INDEX idx_sync_queue_status ON _sync_queue (status, created_at);

-- ID remap table for local-first sync (local UUID → server-assigned ID)
CREATE TABLE IF NOT EXISTS _id_remap (
    local_id TEXT PRIMARY KEY,
    remote_id TEXT,
    resource_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    remapped_at TIMESTAMPTZ
);

CREATE INDEX idx_id_remap_resource_type ON _id_remap (resource_type);
CREATE INDEX idx_id_remap_remote_id ON _id_remap (remote_id) WHERE remote_id IS NOT NULL;

-- Ticket 0107: generic devtools snapshot surface.
--
-- Agent runtime emits the current "what I'm looking at" snapshot via the
-- guest-agent MethodWriteDevtoolsSnapshot (gated by
-- CapabilityDevtoolsSnapshotsWrite, ticket 0131). Plue persists one row
-- per (session_id, kind) using UPSERT; the realtime stream
-- `devtools_snapshots`
-- delivers the latest row to connected clients.
--
-- Retention: latest-per-kind, NOT a history log. Old snapshots for the
-- same (session_id, kind) are clobbered on every write via the composite
-- PRIMARY KEY + ON CONFLICT DO UPDATE path in
-- internal/services/devtools.go. Deleted sessions cascade.
--
-- Large payloads: app-layer capped at 256 KiB. Bigger payloads must be
-- uploaded to blob storage and referenced from the JSON; blob integration
-- is out of scope for ticket 0107.
--
-- See .smithers/tickets/0107-plue-devtools-snapshot-surface.md.
CREATE TABLE IF NOT EXISTS devtools_snapshots (
    session_id     UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('file_tree', 'screenshot', 'command_output', 'tool_state')),
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, kind)
);

-- Backs the production realtime stream (ShapeDevtoolsSnapshots). Leading
-- repository_id supports the proxy's repo-scope predicate; trailing
-- session_id supports the per-tab filter clients apply.
CREATE INDEX IF NOT EXISTS idx_devtools_snapshots_repo_session
    ON devtools_snapshots (repository_id, session_id);

-- Ticket 0110: human-in-the-loop approvals.
--
-- Agent runtime emits a pending-approval request via the guest-agent
-- MethodEmitApprovalRequest (gated by CapabilityApprovalsEmit, ticket 0131);
-- plue persists a row; the realtime approvals stream delivers it to connected
-- clients; clients POST /api/repos/{owner}/{repo}/approvals/{id}/decide.
--
-- Expiry policy: CLIENT-SIDE FILTER. Rows with expires_at < now() may still
-- have state='pending' in the DB. The realtime stream delivers them; the
-- client renders them as "expired" locally. This avoids racing a background
-- sweeper against the decide endpoint and keeps the v1 surface minimal.
-- See .smithers/tickets/0110-plue-approvals-implementation.md.
--
-- session_id NOT NULL (approvals anchor to agent sessions in v1; run-anchored
-- approvals can come later by relaxing NOT NULL and adding a run_id column).
-- repository_id NOT NULL is required for repository-scoped authorization.
CREATE TABLE IF NOT EXISTS approvals (
    id             UUID PRIMARY KEY,
    session_id     UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    state          TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at     TIMESTAMPTZ,
    decided_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    expires_at     TIMESTAMPTZ,
    -- payload caps at ~256KB via application-level check in
    -- internal/services/approvals.go; no DB-level length limit because
    -- JSONB has no built-in cap and a CHECK (octet_length(payload::text))
    -- would be evaluated on every read.
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    -- Consistency: terminal states must have decided_at populated.
    CHECK (
        (state = 'pending'  AND decided_at IS NULL AND decided_by IS NULL)
        OR (state IN ('approved', 'rejected') AND decided_at IS NOT NULL)
        -- 'expired' is reserved for future server-side sweeper use; not
        -- written by v1 code paths (client-side filter only).
        OR state = 'expired'
    )
);

-- Backs the production realtime stream (ShapeApprovals) and the list-pending
-- query in internal/services/approvals.go. Ordering DESC on created_at so
-- the newest pending approvals surface first.
CREATE INDEX IF NOT EXISTS idx_approvals_repo_session_state_created
    ON approvals (repository_id, session_id, state, created_at DESC);

-- Smithers Pair: realtime multiplayer pair-coding room state (see migration 000079).
CREATE TABLE IF NOT EXISTS pair_state (
    room_id    TEXT PRIMARY KEY,
    state      JSONB NOT NULL,
    version    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Smithers Pair: per-room shareable access links (see migration 000085).
--
-- A jjhub user mints a link bound to one room at a chosen access level:
--   'view' can read the room (state/tree/file/diff/stream + the realtime
--   pair_state shape) but MUST NOT drive the shared Codex agent; 'edit' can
--   also mutate the room (file-edit/doc/draft/collab/presence/landing/prompt).
-- The raw token is never stored — only its sha256 hex, matching access_tokens.
CREATE TABLE IF NOT EXISTS pair_share_links (
    id           BIGSERIAL PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    room_id      TEXT NOT NULL,
    level        VARCHAR(8) NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit')),
    created_by   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pair_share_links_room ON pair_share_links (room_id);

-- Alert-driven auto-remediation: GCP Cloud Monitoring incidents received via
-- the alert webhook receiver, plus the durable remediation job queue drained
-- by AlertRemediationWorker (see migration 000083).
CREATE TABLE IF NOT EXISTS alert_incidents (
    id                  BIGSERIAL PRIMARY KEY,
    incident_id         TEXT NOT NULL UNIQUE,
    policy_name         TEXT NOT NULL,
    condition_name      TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'remediating', 'pr_opened', 'resolved', 'failed')),
    summary             TEXT NOT NULL DEFAULT '',
    incident_url        TEXT NOT NULL DEFAULT '',
    runbook             TEXT NOT NULL DEFAULT '',
    workflow            TEXT NOT NULL DEFAULT '',
    remediation_pr_url  TEXT NOT NULL DEFAULT '',
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL DEFAULT 'monitoring',
    occurrences INTEGER NOT NULL DEFAULT 1,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    snoozed_until TIMESTAMPTZ,
    resolved_by TEXT,
    resolution_note TEXT
);

-- Keep delivery identities after deduplication and resolution. A close only
-- resolves the canonical incident after every associated delivery has closed.
CREATE TABLE alert_incident_deliveries (
    incident_id TEXT PRIMARY KEY,
    canonical_incident_id BIGINT NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
);
CREATE INDEX idx_alert_incident_deliveries_live
    ON alert_incident_deliveries (canonical_incident_id) WHERE closed_at IS NULL;

CREATE INDEX idx_alert_incidents_policy_condition_active
  ON alert_incidents (policy_name, condition_name, id)
  WHERE state IN ('open', 'remediating', 'pr_opened');


CREATE INDEX IF NOT EXISTS idx_alert_incidents_policy_active
    ON alert_incidents (policy_name)
    WHERE state IN ('open', 'remediating', 'pr_opened');
CREATE INDEX IF NOT EXISTS idx_alert_incidents_policy_created
    ON alert_incidents (policy_name, created_at DESC);

CREATE OR REPLACE FUNCTION guard_alert_incident_terminal_state()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'resolved'
       OR (OLD.state = 'pr_opened' AND (NEW.state NOT IN ('pr_opened', 'resolved')
           OR (NEW.state = 'pr_opened' AND (NEW.remediation_pr_url IS DISTINCT FROM OLD.remediation_pr_url
               OR NEW.attempts IS DISTINCT FROM OLD.attempts)))) THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alert_incidents_terminal_state_guard
    BEFORE UPDATE OF state ON alert_incidents
    FOR EACH ROW
    EXECUTE FUNCTION guard_alert_incident_terminal_state();

CREATE TABLE IF NOT EXISTS alert_remediation_jobs (
    id            BIGSERIAL PRIMARY KEY,
    incident_id   BIGINT NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT NOT NULL DEFAULT '',
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatch_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex')
                   UNIQUE CHECK (dispatch_token ~ '^[0-9a-f]{64}$'),
    workflow_run_id BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_remediation_jobs_pending_dequeue
    ON alert_remediation_jobs (available_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_alert_remediation_jobs_incident
    ON alert_remediation_jobs (incident_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_remediation_jobs_workflow_run
    ON alert_remediation_jobs (workflow_run_id)
    WHERE workflow_run_id IS NOT NULL;

-- Repo gateways: one durable `smithers gateway` control-plane VM per user+repo.
-- The gateway is a long-lived process inside a Microsandbox micro-VM (like the
-- workspace terminal VMs), reached over Microsandbox HTTPS ingress
-- (external port 443 -> in-VM 7331).
--
-- Token storage: the stock `smithers gateway` accepts ONLY the exact operator
-- token it was started with (fixed in-memory map; no DB tokens, no RPC mint),
-- so per-request ephemeral tokens are impossible without restarting the
-- gateway (which would kill live runs). The operator token is therefore
-- stored encrypted at rest (AES-256-GCM via the same codec that protects
-- repository secrets) plus a SHA-256 hash for audit. Plaintext is never
-- persisted.
CREATE TABLE IF NOT EXISTS repo_gateways (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id         BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id          UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    vm_id                 TEXT NOT NULL DEFAULT '',
    base_url              TEXT NOT NULL DEFAULT '',
    auth_token_hash       TEXT NOT NULL DEFAULT '',
    auth_token_ciphertext TEXT NOT NULL DEFAULT '',
    landing_token_id      BIGINT REFERENCES access_tokens(id) ON DELETE SET NULL,
    status                VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed')),
    last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one live gateway per user+repo. Failed/stopped/tombstoned rows do not
-- block a re-provision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_gateways_active
    ON repo_gateways (repository_id, user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE deleted_at IS NULL
      AND status IN ('starting', 'running', 'suspended');

CREATE INDEX IF NOT EXISTS idx_repo_gateways_status
    ON repo_gateways (status)
    WHERE deleted_at IS NULL;

-- A developer-UID gateway cannot protect its operator token from a write-share
-- shell in the same VM. Serialize both admission paths on the existing workspace
-- row until shared execution has an authenticated initiating-actor boundary.
CREATE OR REPLACE FUNCTION guard_workspace_gateway_sharing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_workspace uuid;
BEGIN
    IF TG_TABLE_NAME = 'repo_gateways' THEN
        IF NEW.workspace_id IS NULL OR NEW.deleted_at IS NOT NULL
           OR NEW.status IN ('stopped', 'failed') THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM workspace_shares WHERE workspace_id = bound_workspace AND level = 'write') THEN
            RAISE EXCEPTION 'workspace coding gateway conflicts with write sharing'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    ELSE
        IF NEW.level <> 'write' THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM repo_gateways WHERE workspace_id = bound_workspace
                   AND (auth_token_hash <> '' OR (deleted_at IS NULL AND status NOT IN ('stopped', 'failed')))) THEN
            RAISE EXCEPTION 'workspace write sharing conflicts with coding gateway'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_repo_gateways_private_execution
BEFORE INSERT OR UPDATE OF workspace_id, status, deleted_at ON repo_gateways
FOR EACH ROW EXECUTE FUNCTION guard_workspace_gateway_sharing();

CREATE TRIGGER trg_workspace_shares_private_execution
BEFORE INSERT OR UPDATE OF workspace_id, level ON workspace_shares
FOR EACH ROW EXECUTE FUNCTION guard_workspace_gateway_sharing();

-- GitHub repo listing cache: one row per user holding the user's merged
-- GET /user/repos listing (canonical shape: sort=pushed, per_page=100 pages
-- concatenated), served stale-while-revalidate by GET /api/user/github-repos.
--
-- Semantics:
--   payload        last-good listing (JSON array of repo objects). NEVER
--                  wiped on refresh failure — failures only record sync_error.
--   synced_at      when payload was last refreshed from GitHub.
--   sync_error     last background refresh failure (cleared on success).
--   syncing_since  singleflight claim: a refresh has been in flight since this
--                  time; claims older than the takeover window (2 minutes) are
--                  considered abandoned and may be re-claimed.
CREATE TABLE IF NOT EXISTS github_repo_listings (
    user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload       JSONB NOT NULL DEFAULT '[]'::jsonb,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_error    TEXT,
    syncing_since TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Smithers Pair sessions (server-authoritative pairing; replaces pair_state as
-- the sync medium). See db/migrations/000088-000092. pair_state is frozen and
-- retired, never extended (decision #4).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pair_sessions (
    id                  TEXT PRIMARY KEY,
    owner_user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workspace_id        UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    access_mode         TEXT NOT NULL DEFAULT 'restricted'
                        CHECK (access_mode IN ('restricted', 'link')),
    status              TEXT NOT NULL DEFAULT 'provisioning'
                        CHECK (status IN ('provisioning', 'active', 'ended', 'failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pair_sessions_live_per_source
    ON pair_sessions (source_workspace_id)
    WHERE status NOT IN ('ended', 'failed');

CREATE INDEX IF NOT EXISTS idx_pair_sessions_owner
    ON pair_sessions (owner_user_id);

CREATE TABLE IF NOT EXISTS pair_session_members (
    session_id            TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role                  TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
    invited_via_invite_id UUID,
    presence              JSONB NOT NULL DEFAULT '{}'::jsonb,
    presence_updated_at   TIMESTAMPTZ,
    last_seen_at          TIMESTAMPTZ,
    joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at            TIMESTAMPTZ,
    PRIMARY KEY (session_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pair_session_one_owner
    ON pair_session_members (session_id)
    WHERE role = 'owner' AND removed_at IS NULL;

CREATE INDEX IF NOT EXISTS pair_session_members_session_live
    ON pair_session_members (session_id)
    WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS pair_prompt_queue (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    seq                BIGINT NOT NULL,
    author_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source             TEXT NOT NULL CHECK (source IN ('solo', 'together')),
    body               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'claimed', 'running', 'done', 'failed', 'canceled')),
    executor_client_id TEXT,
    claim_expires_at   TIMESTAMPTZ,
    run_id             TEXT,
    canceled_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    UNIQUE (session_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS pair_prompt_queue_one_active
    ON pair_prompt_queue (session_id)
    WHERE status IN ('claimed', 'running');

CREATE INDEX IF NOT EXISTS idx_pair_prompt_queue_session_status
    ON pair_prompt_queue (session_id, status);

CREATE TABLE IF NOT EXISTS pair_session_invites (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    -- At least one join key (email or GitHub username) must be present
    -- (migration 000094; plue usernames are GitHub logins).
    lower_email           TEXT,
    lower_github_username TEXT,
    role                  TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    token_hash            TEXT NOT NULL,
    invited_by            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at            TIMESTAMPTZ NOT NULL,
    accepted_by_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    accepted_at           TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pair_session_invites_join_key_present
        CHECK (lower_email IS NOT NULL OR lower_github_username IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS pair_session_invites_session_email
    ON pair_session_invites (session_id, lower_email)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS pair_session_invites_session_username
    ON pair_session_invites (session_id, lower_github_username)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_session_invites_token_hash
    ON pair_session_invites (token_hash);

CREATE TABLE IF NOT EXISTS pair_session_draft (
    session_id TEXT PRIMARY KEY REFERENCES pair_sessions(id) ON DELETE CASCADE,
    content    TEXT NOT NULL DEFAULT '',
    version    BIGINT NOT NULL DEFAULT 0,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pair_session_links (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  TEXT NOT NULL REFERENCES pair_sessions(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_by  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_session_links_slug
    ON pair_session_links (slug);

CREATE UNIQUE INDEX IF NOT EXISTS pair_session_links_one_live_per_role
    ON pair_session_links (session_id, role)
    WHERE revoked_at IS NULL;

-- Golden sandbox snapshots: the pre-baked toolchain image workspace/gateway
-- VMs boot from (see migration 000096). One 'baking' row per kind at a time;
-- the newest 'ready' row is the current golden snapshot.
CREATE TABLE IF NOT EXISTS sandbox_golden_snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT NOT NULL,
    snapshot_id TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'baking' CHECK (status IN ('baking', 'ready', 'failed', 'superseded')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_golden_snapshots_one_baking
    ON sandbox_golden_snapshots (kind) WHERE status = 'baking';
CREATE INDEX IF NOT EXISTS sandbox_golden_snapshots_ready
    ON sandbox_golden_snapshots (kind, created_at DESC) WHERE status = 'ready';

-- NixOS environment images: the compute path for kind=vm and kind=desktop
-- workspaces. One row per (repository, kind, closure hash); repository_id NULL
-- rows are the platform base images (nix/modules/base.nix, plus desktop.nix for
-- kind=desktop) every repository without a registered image boots from. The
-- image tag is the closure hash of the NixOS toplevel, so a row is immutable
-- content: re-registering the same closure is an idempotent upsert.
CREATE TABLE IF NOT EXISTS sandbox_environment_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('vm', 'desktop')),
    source          TEXT NOT NULL DEFAULT '.smithers/environment.nix',
    source_revision TEXT NOT NULL DEFAULT '',
    closure_hash    TEXT NOT NULL CHECK (closure_hash <> ''),
    image           TEXT NOT NULL CHECK (image <> ''),
    status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'retired')),
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_environment_images_closure
    ON sandbox_environment_images ((COALESCE(repository_id, 0)), kind, closure_hash);
CREATE INDEX IF NOT EXISTS sandbox_environment_images_ready
    ON sandbox_environment_images ((COALESCE(repository_id, 0)), kind, created_at DESC)
    WHERE status = 'ready';
CREATE UNIQUE INDEX sandbox_environment_images_one_ready_base
    ON sandbox_environment_images (kind)
    WHERE repository_id IS NULL AND status = 'ready';

CREATE OR REPLACE FUNCTION register_sandbox_environment_image(
    p_repository_id BIGINT,
    p_kind TEXT,
    p_source TEXT,
    p_source_revision TEXT,
    p_closure_hash TEXT,
    p_image TEXT,
    p_created_by BIGINT
)
RETURNS sandbox_environment_images
LANGUAGE plpgsql
AS $$
DECLARE
    registered sandbox_environment_images%ROWTYPE;
BEGIN
    IF p_repository_id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('sandbox-base:' || p_kind, 0));
        UPDATE sandbox_environment_images
        SET status = 'retired', updated_at = NOW()
        WHERE repository_id IS NULL
          AND kind = p_kind
          AND closure_hash <> p_closure_hash
          AND status = 'ready';
    END IF;

    INSERT INTO sandbox_environment_images (
        repository_id, kind, source, source_revision, closure_hash, image, created_by
    ) VALUES (
        p_repository_id, p_kind,
        COALESCE(NULLIF(p_source, ''), '.smithers/environment.nix'),
        p_source_revision, p_closure_hash, p_image, p_created_by
    )
    ON CONFLICT ((COALESCE(repository_id, 0)), kind, closure_hash) DO UPDATE SET
        image = EXCLUDED.image,
        source = EXCLUDED.source,
        source_revision = EXCLUDED.source_revision,
        status = 'ready',
        updated_at = NOW()
    RETURNING * INTO registered;

    RETURN registered;
END;
$$;

-- File drafts: live-synced multiplayer editing buffers behind the web file
-- editor. One row per (repository, bookmark, path); whole-buffer version-CAS
-- writes over REST, converged via the realtime `file_drafts` stream. Committing
-- or discarding a draft tombstones it (deleted_at) so subscribers observe a
-- visible -> hidden transition. See db/migrations/000097_add_file_drafts.sql.
CREATE TABLE IF NOT EXISTS file_drafts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    bookmark       TEXT NOT NULL,
    path           TEXT NOT NULL,
    content        TEXT NOT NULL DEFAULT '',
    version        BIGINT NOT NULL DEFAULT 0,
    base_change_id TEXT NOT NULL DEFAULT '',
    updated_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_file_drafts_repo_bookmark_path UNIQUE (repository_id, bookmark, path)
);

CREATE INDEX IF NOT EXISTS idx_file_drafts_repo_bookmark_live
    ON file_drafts (repository_id, bookmark)
    WHERE deleted_at IS NULL;

-- App-machine timelines: the authoritative, realtime-synchronized copy of the multi
-- frontend's xstate machine history (event log + sealed fork branches +
-- periodic snapshots). Membership-owned (pair_session_members pattern) so a
-- timeline is pairing-ready without redesign. Writes over REST
-- (/api/app-timelines*), reads via the app_timeline_* realtime streams.
-- See db/migrations/20260719144500_add_app_timelines.sql.
CREATE TABLE IF NOT EXISTS app_timelines (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_key    TEXT NOT NULL DEFAULT 'default'
                  CHECK (LENGTH(client_key) BETWEEN 1 AND 128),
    version       INTEGER NOT NULL DEFAULT 1,
    head_seq      BIGINT NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_timelines_owner_client
    ON app_timelines (owner_user_id, client_key)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app_timeline_members (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at  TIMESTAMPTZ,
    PRIMARY KEY (timeline_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_timeline_one_owner
    ON app_timeline_members (timeline_id)
    WHERE role = 'owner' AND removed_at IS NULL;

CREATE INDEX IF NOT EXISTS app_timeline_members_timeline_live
    ON app_timeline_members (timeline_id)
    WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS app_timeline_events (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL CHECK (seq >= 0),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, seq)
);

CREATE TABLE IF NOT EXISTS app_timeline_branches (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
    from_seq    BIGINT NOT NULL CHECK (from_seq >= 0),
    events      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, ordinal)
);

CREATE TABLE IF NOT EXISTS app_timeline_snapshots (
    timeline_id UUID NOT NULL REFERENCES app_timelines(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL CHECK (seq >= 0),
    state       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (timeline_id, seq)
);

-- Anonymous sandboxes: signed-out open of an allowlisted public repo
-- (../multi SPEC.md §3). Deliberately no user linkage; token-capability
-- access; hard TTL with delete-not-suspend reaping.
-- See db/migrations/20260719163427_add_anon_sandboxes.sql.
CREATE TABLE IF NOT EXISTS anon_sandboxes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_full_name     TEXT NOT NULL CHECK (LENGTH(repo_full_name) BETWEEN 3 AND 255),
    branch             TEXT NOT NULL DEFAULT 'main' CHECK (LENGTH(branch) BETWEEN 1 AND 128),
    vm_id              TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'starting', 'running', 'failed', 'deleted')),
    provisioning_stage TEXT NOT NULL DEFAULT '',
    token_hash         TEXT NOT NULL UNIQUE CHECK (LENGTH(token_hash) = 64),
    client_ip          TEXT NOT NULL DEFAULT '',
    expires_at         TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_status
    ON anon_sandboxes (status)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_expires_at
    ON anon_sandboxes (expires_at)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_client_ip
    ON anon_sandboxes (client_ip)
    WHERE deleted_at IS NULL;

-- Durable, invisible repository reservations. Added by migration 20260718000900.
CREATE TABLE repository_provisioning_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enforce_insert_fence BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO repository_provisioning_control (singleton, enforce_insert_fence)
VALUES (TRUE, FALSE);

CREATE TABLE repository_provisioning_operations (
    repository_id       BIGINT PRIMARY KEY,
    operation_type      VARCHAR(16) NOT NULL CHECK (operation_type IN ('init', 'fork', 'import')),
    token               VARCHAR(64) NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
    actor_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    storage_set_id      TEXT NOT NULL REFERENCES repo_storage_sets(id),
    owner_name          VARCHAR(255) NOT NULL,
    user_id             BIGINT REFERENCES users(id),
    org_id              BIGINT REFERENCES organizations(id),
    name                VARCHAR(255) NOT NULL,
    lower_name          VARCHAR(255) NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    is_public           BOOLEAN NOT NULL,
    default_bookmark    VARCHAR(255) NOT NULL,
    auto_init           BOOLEAN NOT NULL DEFAULT FALSE,
    is_fork             BOOLEAN NOT NULL DEFAULT FALSE,
    fork_id             BIGINT REFERENCES repositories(id) ON DELETE RESTRICT,
    source_repository_id BIGINT REFERENCES repositories(id) ON DELETE RESTRICT,
    source_owner        VARCHAR(255),
    source_repo         VARCHAR(255),
    source_storage_set_id TEXT REFERENCES repo_storage_sets(id),
    publish_ready       BOOLEAN NOT NULL DEFAULT FALSE,
    claim_token         VARCHAR(64),
    claimed_at          TIMESTAMPTZ,
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(user_id, org_id) = 1),
    CHECK (user_id IS NULL OR actor_id = user_id),
    CHECK (lower_name = LOWER(name)),
    CHECK (owner_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
    CHECK (LENGTH(name) <= 100 AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
    CHECK (LOWER(name) !~ '\.(git|wiki|docs)$'),
    CHECK (LOWER(name) NOT IN (
        'agent', 'bookmarks', 'changes', 'commits', 'contributors', 'issues',
        'labels', 'landings', 'milestones', 'operations', 'pulls', 'settings',
        'stargazers', 'watchers', 'workflows'
    )),
    CHECK (BTRIM(default_bookmark) <> ''),
    CHECK (
        (operation_type IN ('init', 'import') AND NOT is_fork
         AND fork_id IS NULL AND source_repository_id IS NULL
         AND source_owner IS NULL AND source_repo IS NULL AND source_storage_set_id IS NULL)
        OR
        (operation_type = 'fork' AND is_fork AND fork_id IS NOT NULL
         AND source_repository_id = fork_id
         AND source_owner IS NOT NULL AND source_owner ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
         AND source_repo IS NOT NULL AND LENGTH(source_repo) <= 100
         AND source_repo ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
         AND LOWER(source_repo) !~ '\.(git|wiki|docs)$'
         AND source_storage_set_id = storage_set_id)
    ),
    CHECK ((claim_token IS NULL AND claimed_at IS NULL)
           OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_repository_provisioning_user_name
    ON repository_provisioning_operations (user_id, lower_name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_repository_provisioning_org_name
    ON repository_provisioning_operations (org_id, lower_name) WHERE org_id IS NOT NULL;
CREATE INDEX idx_repository_provisioning_reconcile
    ON repository_provisioning_operations (publish_ready, created_at, claimed_at, repository_id);
CREATE INDEX idx_repository_provisioning_source
    ON repository_provisioning_operations (source_repository_id) WHERE source_repository_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_repository_provisioning_operation()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_name TEXT;
    v_owner_type TEXT;
    v_owner_id BIGINT;
    v_source RECORD;
    v_authorized BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
           OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
           OR NEW.token IS DISTINCT FROM OLD.token
           OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
           OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id
           OR NEW.owner_name IS DISTINCT FROM OLD.owner_name
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
           OR NEW.description IS DISTINCT FROM OLD.description
           OR NEW.is_public IS DISTINCT FROM OLD.is_public
           OR NEW.default_bookmark IS DISTINCT FROM OLD.default_bookmark
           OR NEW.auto_init IS DISTINCT FROM OLD.auto_init
           OR NEW.is_fork IS DISTINCT FROM OLD.is_fork
           OR NEW.fork_id IS DISTINCT FROM OLD.fork_id
           OR NEW.source_repository_id IS DISTINCT FROM OLD.source_repository_id
           OR NEW.source_owner IS DISTINCT FROM OLD.source_owner
           OR NEW.source_repo IS DISTINCT FROM OLD.source_repo
           OR NEW.source_storage_set_id IS DISTINCT FROM OLD.source_storage_set_id THEN
            RAISE EXCEPTION USING ERRCODE = '0A000',
                MESSAGE = 'repository provisioning identity is immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        v_owner_type := 'user';
        v_owner_id := NEW.user_id;
        SELECT username INTO v_owner_name FROM users WHERE id = NEW.user_id FOR KEY SHARE;
    ELSE
        v_owner_type := 'org';
        v_owner_id := NEW.org_id;
        SELECT name INTO v_owner_name FROM organizations WHERE id = NEW.org_id FOR KEY SHARE;
    END IF;
    IF v_owner_name IS NULL OR v_owner_name IS DISTINCT FROM NEW.owner_name THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'repository provisioning owner identity does not match';
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.actor_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'repository provisioning actor does not exist';
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        IF NEW.actor_id IS DISTINCT FROM NEW.user_id THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor cannot create for this user';
        END IF;
    ELSE
        PERFORM 1 FROM org_members
        WHERE organization_id = NEW.org_id AND user_id = NEW.actor_id AND role = 'owner'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor is not an organization owner';
        END IF;
    END IF;
    IF NEW.operation_type = 'fork' THEN
        SELECT r.user_id, r.org_id, r.name, r.storage_set_id, r.is_public,
               COALESCE(u.username, o.name) AS owner_name
        INTO v_source
        FROM repositories r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN organizations o ON o.id = r.org_id
        WHERE r.id = NEW.source_repository_id
        FOR UPDATE OF r;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;
        IF v_source.owner_name IS DISTINCT FROM NEW.source_owner
           OR v_source.name IS DISTINCT FROM NEW.source_repo
           OR v_source.storage_set_id IS DISTINCT FROM NEW.source_storage_set_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;
        IF NOT v_source.is_public THEN
            -- Comparisons against an organization-owned source yield NULL for
            -- user_id. Normalize that three-valued result before using it as
            -- an authorization accumulator; otherwise every subsequent
            -- "IF NOT v_authorized" guard is skipped.
            v_authorized := COALESCE(v_source.user_id = NEW.actor_id, FALSE);
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM org_members om
                WHERE om.organization_id = v_source.org_id
                  AND om.user_id = NEW.actor_id
                  AND om.role = 'owner'
                FOR UPDATE OF om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM team_repos tr
                JOIN teams t ON t.id = tr.team_id
                JOIN team_members tm ON tm.team_id = t.id
                JOIN org_members om
                  ON om.organization_id = t.organization_id
                 AND om.user_id = tm.user_id
                WHERE tr.repository_id = NEW.source_repository_id
                  AND tm.user_id = NEW.actor_id
                  AND t.organization_id = v_source.org_id
                  AND t.permission IN ('read', 'write', 'admin')
                LIMIT 1
                FOR UPDATE OF tr, t, tm, om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                SELECT TRUE INTO v_authorized
                FROM collaborators c
                WHERE c.repository_id = NEW.source_repository_id
                  AND c.user_id = NEW.actor_id
                  AND c.permission IN ('read', 'write', 'admin')
                FOR UPDATE OF c;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                RAISE EXCEPTION USING ERRCODE = '42501',
                    MESSAGE = 'repository provisioning actor cannot read fork source';
            END IF;
        END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
    ));
    IF EXISTS (
        SELECT 1 FROM repositories
        WHERE lower_name = NEW.lower_name
          AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
               OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'repository provisioning namespace is already occupied';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repository_provisioning_validate_identity
    BEFORE INSERT OR UPDATE ON repository_provisioning_operations
    FOR EACH ROW EXECUTE FUNCTION validate_repository_provisioning_operation();

CREATE OR REPLACE FUNCTION fence_repository_provisioning_operation()
RETURNS TRIGGER AS $$
DECLARE
    v_operation repository_provisioning_operations%ROWTYPE;
    v_authorized_token TEXT := NULLIF(current_setting('smithers.repository_provisioning_token', TRUE), '');
    v_owner_type TEXT;
    v_owner_id BIGINT;
    v_enforce_insert_fence BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.user_id IS NOT NULL THEN
            v_owner_type := 'user'; v_owner_id := NEW.user_id;
        ELSE
            v_owner_type := 'org'; v_owner_id := NEW.org_id;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
            FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
        ));
        SELECT * INTO v_operation
        FROM repository_provisioning_operations
        WHERE repository_id = NEW.id
        FOR UPDATE;
        IF NOT FOUND THEN
            SELECT enforce_insert_fence INTO STRICT v_enforce_insert_fence
            FROM repository_provisioning_control
            WHERE singleton;
            IF v_authorized_token IS NOT NULL
               OR v_enforce_insert_fence
               OR EXISTS (
                    SELECT 1 FROM repository_provisioning_operations
                    WHERE lower_name = NEW.lower_name
                      AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
                           OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
               ) THEN
                RAISE EXCEPTION USING ERRCODE = '55006',
                    MESSAGE = 'repository insertion requires an authorized published provisioning operation',
                    DETAIL = FORMAT('Repository %s has no matching publish-ready repo-host journal.', NEW.id),
                    HINT = 'Create repositories through the durable provisioning service.';
            END IF;
            RETURN NEW;
        END IF;
        IF NOT v_operation.publish_ready
           OR v_operation.token IS DISTINCT FROM v_authorized_token
           OR NEW.user_id IS DISTINCT FROM v_operation.user_id
           OR NEW.org_id IS DISTINCT FROM v_operation.org_id
           OR NEW.name IS DISTINCT FROM v_operation.name
           OR NEW.lower_name IS DISTINCT FROM v_operation.lower_name
           OR NEW.description IS DISTINCT FROM v_operation.description
           OR NEW.storage_set_id IS DISTINCT FROM v_operation.storage_set_id
           OR NEW.is_public IS DISTINCT FROM v_operation.is_public
           OR NEW.default_bookmark IS DISTINCT FROM v_operation.default_bookmark
           OR NEW.is_fork IS DISTINCT FROM v_operation.is_fork
           OR NEW.fork_id IS DISTINCT FROM v_operation.fork_id THEN
            RAISE EXCEPTION USING ERRCODE = '55006',
                MESSAGE = 'repository insertion requires an authorized published provisioning operation',
                DETAIL = FORMAT('Repository %s does not match a publish-ready repo-host journal.', NEW.id),
                HINT = 'Create repositories through the durable provisioning service.';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.lower_name IS DISTINCT FROM OLD.lower_name) THEN
        IF NEW.user_id IS NOT NULL THEN
            v_owner_type := 'user'; v_owner_id := NEW.user_id;
        ELSE
            v_owner_type := 'org'; v_owner_id := NEW.org_id;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
            FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
        ));
        IF EXISTS (
            SELECT 1 FROM repository_provisioning_operations
            WHERE lower_name = NEW.lower_name
              AND repository_id <> OLD.id
              AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
                   OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '55006',
                MESSAGE = 'repository provisioning namespace is reserved';
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE repository_id = OLD.id) THEN
        RAISE EXCEPTION USING ERRCODE = '55006',
            MESSAGE = 'repository provisioning operation is still being finalized',
            DETAIL = FORMAT('Repository %s still has a repo-host provisioning journal.', OLD.id),
            HINT = 'Wait for the durable repository provisioning reconciler.';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_provisioning_operation
    BEFORE INSERT OR UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_provisioning_operation();

CREATE OR REPLACE FUNCTION fence_repository_provisioning_source()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE source_repository_id = OLD.id) THEN
            RAISE EXCEPTION USING ERRCODE = '55006',
                MESSAGE = 'repository is the source of an active provisioning operation',
                DETAIL = FORMAT('Repository %s cannot be deleted until its fork snapshot is settled.', OLD.id),
                HINT = 'Wait for the durable repository provisioning reconciler.';
        END IF;
        RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE source_repository_id = OLD.id)
       AND (NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.org_id IS DISTINCT FROM OLD.org_id
            OR NEW.name IS DISTINCT FROM OLD.name
            OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
            OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id) THEN
        RAISE EXCEPTION USING ERRCODE = '55006',
            MESSAGE = 'repository is the source of an active provisioning operation',
            DETAIL = FORMAT('Repository %s cannot move or be deleted until its fork snapshot is settled.', OLD.id),
            HINT = 'Wait for the durable repository provisioning reconciler.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_provisioning_source
    BEFORE UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_provisioning_source();

CREATE OR REPLACE FUNCTION prevent_owner_delete_with_repositories()
RETURNS TRIGGER AS $$
DECLARE
    v_enforce_repository_storage BOOLEAN;
BEGIN
    SELECT enforce_repository_storage
    INTO STRICT v_enforce_repository_storage
    FROM legacy_mutation_fence_control
    WHERE singleton;

    IF TG_TABLE_NAME = 'users' AND (
        (v_enforce_repository_storage
         AND EXISTS (SELECT 1 FROM repositories WHERE user_id = OLD.id))
        OR EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE user_id = OLD.id)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55006',
            MESSAGE = 'cannot delete user while repositories or provisioning operations still exist',
            HINT = 'Settle every durable repository workflow first.';
    ELSIF TG_TABLE_NAME = 'organizations' AND (
        (v_enforce_repository_storage
         AND EXISTS (SELECT 1 FROM repositories WHERE org_id = OLD.id))
        OR EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE org_id = OLD.id)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55006',
            MESSAGE = 'cannot delete organization while repositories or provisioning operations still exist',
            HINT = 'Settle every durable repository workflow first.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Self-hosted Microsandbox placement, durable snapshots, access grants, and
-- preview mappings. Keep synchronized with migration 20260718000000.
CREATE TABLE IF NOT EXISTS sandbox_hosts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'microsandbox',
    identity_public_key BYTEA NOT NULL CHECK (octet_length(identity_public_key) = 32),
    identity_signed_at TIMESTAMPTZ NOT NULL,
    base_url TEXT NOT NULL,
    boot_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'draining', 'stale', 'fenced')),
    placement_generation BIGINT NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    capacity_cpu_millis BIGINT NOT NULL CHECK (capacity_cpu_millis >= 0),
    capacity_memory_bytes BIGINT NOT NULL CHECK (capacity_memory_bytes >= 0),
    capacity_disk_bytes BIGINT NOT NULL CHECK (capacity_disk_bytes >= 0),
    capacity_vms INTEGER NOT NULL CHECK (capacity_vms >= 0),
    allocated_cpu_millis BIGINT NOT NULL DEFAULT 0 CHECK (allocated_cpu_millis >= 0),
    allocated_memory_bytes BIGINT NOT NULL DEFAULT 0 CHECK (allocated_memory_bytes >= 0),
    allocated_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK (allocated_disk_bytes >= 0),
    allocated_vms INTEGER NOT NULL DEFAULT 0 CHECK (allocated_vms >= 0),
    observed_allocated_cpu_millis BIGINT NOT NULL DEFAULT 0 CHECK (observed_allocated_cpu_millis >= 0),
    observed_allocated_memory_bytes BIGINT NOT NULL DEFAULT 0 CHECK (observed_allocated_memory_bytes >= 0),
    observed_allocated_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK (observed_allocated_disk_bytes >= 0),
    observed_allocated_vms INTEGER NOT NULL DEFAULT 0 CHECK (observed_allocated_vms >= 0),
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    runtime_version TEXT NOT NULL DEFAULT '',
    worker_image TEXT NOT NULL DEFAULT '',
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sandbox_hosts_schedulable_idx
    ON sandbox_hosts (state, lease_expires_at, allocated_vms, heartbeat_at);

CREATE TABLE IF NOT EXISTS sandbox_instances (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_local_id TEXT NOT NULL,
    worker_id TEXT REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation BIGINT NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    desired_state TEXT NOT NULL DEFAULT 'running' CHECK (desired_state IN ('created', 'running', 'stopped', 'deleted')),
    observed_state TEXT NOT NULL DEFAULT 'starting' CHECK (observed_state IN ('created', 'starting', 'running', 'stopping', 'stopped', 'restart_pending', 'recovering', 'deleting', 'degraded', 'failed', 'deleted')),
    resource_kind TEXT,
    resource_id TEXT,
    image_ref TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT,
    recovery_snapshot_id TEXT,
    recovery_point_at TIMESTAMPTZ,
    request_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
    recovery_services JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recovery_services) = 'array'),
    requested_cpu_millis BIGINT NOT NULL DEFAULT 1000 CHECK (requested_cpu_millis >= 0),
    requested_memory_bytes BIGINT NOT NULL DEFAULT 0 CHECK (requested_memory_bytes >= 0),
    requested_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK (requested_disk_bytes >= 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    -- Latest host heartbeat whose compute aggregate included this placement.
    -- Stopped guests on current workers remain in inventory/last_heartbeat_at
    -- for retained-disk accounting but are absent from compute_observed_at.
    compute_observed_at TIMESTAMPTZ,
    cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
    -- TRUE while this instance's CPU, memory, and active-VM reservation is
    -- counted in sandbox_hosts.allocated_*. Suspending/stopping hands compute
    -- back (FALSE); retained disk stays charged until delete. Resume re-acquires
    -- compute and fails with no_capacity when the pool filled up meanwhile.
    reservation_held BOOLEAN NOT NULL DEFAULT TRUE,
    recovery_reason TEXT NOT NULL DEFAULT '' CHECK (recovery_reason IN ('', 'worker_lost', 'planned_drain', 'secrets_required')),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (provider, provider_local_id)
);
CREATE INDEX IF NOT EXISTS sandbox_instances_worker_state_idx
    ON sandbox_instances (worker_id, observed_state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sandbox_instances_resource_idx
    ON sandbox_instances (resource_kind, resource_id) WHERE deleted_at IS NULL;

-- High-volume per-request audit history emitted by each sandbox's egress
-- proxy. This is deliberately separate from audit_log: lifecycle/admin audit
-- events and request telemetry have different volume and retention classes.
CREATE TABLE IF NOT EXISTS sandbox_egress_audit (
    id BIGSERIAL PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (length(resource_kind) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
    repository_id BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    host VARCHAR(253) NOT NULL CHECK (length(host) > 0),
    method VARCHAR(16) NOT NULL CHECK (length(method) > 0),
    path VARCHAR(2048) NOT NULL,
    status INTEGER NOT NULL CHECK (status BETWEEN 0 AND 999),
    allowed BOOLEAN NOT NULL,
    swapped_secret_names TEXT[] NOT NULL DEFAULT '{}',
    transform_summary JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(transform_summary) = 'object' AND pg_column_size(transform_summary) <= 16384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (cardinality(swapped_secret_names) <= 64),
    CHECK (array_position(swapped_secret_names, NULL) IS NULL)
);
CREATE INDEX IF NOT EXISTS sandbox_egress_audit_resource_occurred_idx
    ON sandbox_egress_audit (resource_kind, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sandbox_egress_audit_repository_occurred_idx
    ON sandbox_egress_audit (repository_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_operations (
    idempotency_key TEXT PRIMARY KEY,
    sandbox_id TEXT REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
    request_digest TEXT NOT NULL,
    response JSONB,
    error_code TEXT NOT NULL DEFAULT '',
    lease_expires_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sandbox_operations_expiry_idx ON sandbox_operations (expires_at);

CREATE TABLE IF NOT EXISTS sandbox_snapshots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_local_id TEXT NOT NULL,
    source_sandbox_id TEXT REFERENCES sandbox_instances(id) ON DELETE SET NULL,
    worker_id TEXT REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation BIGINT NOT NULL CHECK (placement_generation > 0),
    state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'exporting', 'exported', 'failed', 'deleting', 'deleted')),
    scope TEXT NOT NULL DEFAULT 'disk' CHECK (scope = 'disk'),
    object_uri TEXT,
    digest TEXT,
    size_bytes BIGINT,
    cleanup_owner TEXT,
    cleanup_lease_expires_at TIMESTAMPTZ,
    garbage_collectible BOOLEAN NOT NULL DEFAULT false,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (provider, provider_local_id)
);
CREATE INDEX IF NOT EXISTS sandbox_snapshots_cleanup_idx
    ON sandbox_snapshots (state, updated_at, cleanup_lease_expires_at)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sandbox_volumes (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_local_id TEXT NOT NULL,
    worker_id TEXT REFERENCES sandbox_hosts(id) ON DELETE SET NULL,
    placement_generation BIGINT NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
    state TEXT NOT NULL DEFAULT 'created',
    quota_bytes BIGINT CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
    object_uri TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (provider, provider_local_id)
);

CREATE TABLE IF NOT EXISTS sandbox_access_identities (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_access_permissions (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES sandbox_access_identities(id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    allowed_users TEXT[] NOT NULL DEFAULT '{}',
    placement_generation BIGINT NOT NULL CHECK (placement_generation > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identity_id, sandbox_id)
);
CREATE INDEX IF NOT EXISTS sandbox_access_permissions_sandbox_idx
    ON sandbox_access_permissions (sandbox_id, identity_id);
CREATE TABLE IF NOT EXISTS sandbox_access_grants (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES sandbox_access_identities(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    protocol TEXT NOT NULL DEFAULT 'ssh' CHECK (protocol IN ('ssh', 'terminal', 'preview')),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sandbox_access_grants_expiry_idx
    ON sandbox_access_grants (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sandbox_domain_mappings (
    domain TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    guest_port INTEGER NOT NULL CHECK (guest_port > 0 AND guest_port <= 65535),
    placement_generation BIGINT NOT NULL CHECK (placement_generation > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sandbox_orphans (
    worker_id TEXT NOT NULL REFERENCES sandbox_hosts(id) ON DELETE CASCADE,
    provider_local_id TEXT NOT NULL,
    placement_generation BIGINT NOT NULL CHECK (placement_generation > 0),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delete_after TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (worker_id, provider_local_id, placement_generation)
);
CREATE INDEX IF NOT EXISTS sandbox_orphans_delete_idx
    ON sandbox_orphans (worker_id, delete_after);

-- Durable control-plane state for the Hindsight memory companion. These rows
-- contain only derived object IDs and upstream operation/memory IDs; memory
-- content remains exclusively in Hindsight's separately owned database.
CREATE TABLE IF NOT EXISTS memory_provisioning_tasks (
    id               BIGSERIAL PRIMARY KEY,
    target_kind      VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project')),
    target_id        BIGINT NOT NULL CHECK (target_id > 0),
    status           VARCHAR(16) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error       TEXT,
    available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_provisioning_claim
    ON memory_provisioning_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_provisioning_stale
    ON memory_provisioning_tasks (lease_expires_at)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS memory_promotion_tasks (
    id                 BIGSERIAL PRIMARY KEY,
    landing_request_id BIGINT NOT NULL REFERENCES landing_requests(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_bookmark    VARCHAR(255) NOT NULL,
    target_bookmark    VARCHAR(255) NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'done', 'failed')),
    phase              VARCHAR(16) NOT NULL DEFAULT 'snapshot'
                       CHECK (phase IN ('snapshot', 'reflect', 'invalidate')),
    outcome            VARCHAR(16) CHECK (outcome IN ('promoted', 'empty', 'skipped')),
    attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error         TEXT,
    operation_id       TEXT,
    available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at   TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (landing_request_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_promotion_claim
    ON memory_promotion_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_promotion_stale
    ON memory_promotion_tasks (lease_expires_at)
    WHERE status = 'running';

-- Immutable source snapshot for retry-safe promotion. A promotion never
-- re-derives this set after reflection/retain starts, so partial invalidation
-- cannot make a retry observe an empty or truncated branch.
CREATE TABLE IF NOT EXISTS memory_promotion_items (
    promotion_task_id BIGINT NOT NULL REFERENCES memory_promotion_tasks(id) ON DELETE CASCADE,
    memory_id         TEXT NOT NULL,
    stream_tags       TEXT[] NOT NULL DEFAULT '{}'::text[],
    captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at    TIMESTAMPTZ,
    PRIMARY KEY (promotion_task_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_ingest_cursors (
    session_id           UUID PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    document_id          TEXT NOT NULL UNIQUE,
    last_message_sequence BIGINT NOT NULL DEFAULT -1 CHECK (last_message_sequence >= -1),
    last_operation_id    TEXT,
    accepted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Durable rotation state for bounded maintenance passes over Hindsight banks.
-- Each maintenance kind advances independently and wraps after the final bank.
CREATE TABLE IF NOT EXISTS memory_maintenance_cursors (
    maintenance_kind VARCHAR(64) PRIMARY KEY,
    last_bank_id     TEXT NOT NULL CHECK (BTRIM(last_bank_id) <> ''),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Durable acceptance state for one transcript delta. document_id is a
-- Plue-local deterministic batch key; Hindsight receives the stable session
-- document ID with append semantics. Once accepted, a crash before cursor
-- advancement resumes from this row without submitting the append again.
CREATE TABLE IF NOT EXISTS memory_ingest_batches (
    id                    BIGSERIAL PRIMARY KEY,
    session_id            UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    from_message_sequence BIGINT NOT NULL CHECK (from_message_sequence >= 0),
    through_message_sequence BIGINT NOT NULL CHECK (through_message_sequence >= from_message_sequence),
    document_id           TEXT NOT NULL UNIQUE,
    payload_sha256        VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    status                VARCHAR(24) NOT NULL DEFAULT 'prepared'
                          CHECK (status IN ('prepared', 'accepted', 'cursor_advanced')),
    operation_id          TEXT,
    accepted_at           TIMESTAMPTZ,
    cursor_advanced_at    TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, from_message_sequence, through_message_sequence)
);

CREATE INDEX IF NOT EXISTS idx_memory_ingest_batches_pending
    ON memory_ingest_batches (status, created_at, id)
    WHERE status <> 'cursor_advanced';

CREATE TABLE IF NOT EXISTS memory_cleanup_tasks (
    id                    BIGSERIAL PRIMARY KEY,
    task_kind             VARCHAR(24) NOT NULL
                          CHECK (task_kind IN ('branch', 'project_bank', 'user_bank')),
    target_id             BIGINT NOT NULL CHECK (target_id > 0),
    bookmark              VARCHAR(255),
    source_revision       TEXT,
    deletion_event_at     TIMESTAMPTZ NOT NULL,
    snapshot_completed_at TIMESTAMPTZ,
    idempotency_key       TEXT NOT NULL UNIQUE,
    status                VARCHAR(32) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('awaiting_source_delete', 'pending', 'running', 'done')),
    attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    last_error_class      VARCHAR(64),
    available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at      TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((task_kind = 'branch' AND bookmark IS NOT NULL) OR
           (task_kind IN ('project_bank', 'user_bank') AND bookmark IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_memory_cleanup_claim
    ON memory_cleanup_tasks (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_cleanup_stale
    ON memory_cleanup_tasks (lease_expires_at)
    WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_memory_cleanup_target
    ON memory_cleanup_tasks (task_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_cleanup_items (
    cleanup_task_id BIGINT NOT NULL REFERENCES memory_cleanup_tasks(id) ON DELETE CASCADE,
    memory_id       TEXT NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at  TIMESTAMPTZ,
    PRIMARY KEY (cleanup_task_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_write_freezes (
    id               BIGSERIAL PRIMARY KEY,
    target_kind      VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project', 'all')),
    target_id        BIGINT,
    lease_token      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    operator_id      TEXT NOT NULL,
    reason           TEXT NOT NULL,
    acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    released_at      TIMESTAMPTZ,
    CHECK ((target_kind = 'all' AND target_id IS NULL) OR
           (target_kind IN ('user', 'project') AND target_id > 0)),
    CHECK (expires_at > acquired_at AND expires_at <= acquired_at + INTERVAL '2 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_write_freezes_active_target
    ON memory_write_freezes (target_kind, COALESCE(target_id, 0))
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_write_freezes_expiry
    ON memory_write_freezes (expires_at)
    WHERE released_at IS NULL;

-- Stable, content-free source inventory for an isolated restore. The manifest
-- contains only provider IDs, counts, configuration, and content hashes; it is
-- lifecycle coordination needed to prove a later import is complete.
CREATE TABLE IF NOT EXISTS memory_restore_manifests (
    restore_id      VARCHAR(128) PRIMARY KEY
                    CHECK (restore_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    target_kind     VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project')),
    target_id       BIGINT NOT NULL CHECK (target_id > 0),
    operation_id    TEXT NOT NULL CHECK (BTRIM(operation_id) <> ''),
    source_manifest JSONB NOT NULL CHECK (jsonb_typeof(source_manifest) = 'object'),
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Branch locks: one person checks out a branch at a time (see migration
-- 20260720120000). Liveness-based: the holder heartbeats while the workspace
-- is open; a stale lock may be taken over. An approved join request lets a
-- second user acquire the held branch.
CREATE TABLE IF NOT EXISTS branch_locks (
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch         VARCHAR(255) NOT NULL CHECK (LENGTH(branch) BETWEEN 1 AND 255),
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id   UUID,
    heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, branch)
);

CREATE INDEX idx_branch_locks_user ON branch_locks (user_id);
CREATE INDEX idx_branch_locks_heartbeat ON branch_locks (heartbeat_at);

CREATE TABLE IF NOT EXISTS branch_lock_join_requests (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch         VARCHAR(255) NOT NULL CHECK (LENGTH(branch) BETWEEN 1 AND 255),
    requester_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status         VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
    resolver_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_branch_lock_join_requests_pending
    ON branch_lock_join_requests (repository_id, branch, requester_id)
    WHERE status = 'pending';
CREATE INDEX idx_branch_lock_join_requests_holder
    ON branch_lock_join_requests (repository_id, branch)
    WHERE status = 'pending';
CREATE INDEX idx_branch_lock_join_requests_requester
    ON branch_lock_join_requests (requester_id, status);

-- ---------------------------------------------------------------------------
-- Continuously-synced GitHub mirror registry + metadata store
-- (see db/migrations/20260802120000_add_github_synced_repos.sql)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS github_synced_repos (
    id                BIGSERIAL PRIMARY KEY,
    owner_login       VARCHAR(255) NOT NULL CHECK (LENGTH(owner_login) BETWEEN 1 AND 255),
    owner_login_lower VARCHAR(255) NOT NULL,
    repo_name         VARCHAR(255) NOT NULL CHECK (LENGTH(repo_name) BETWEEN 1 AND 255),
    repo_name_lower   VARCHAR(255) NOT NULL,
    installation_id   BIGINT,
    -- GitHub's immutable numeric repo id: survives renames and transfers, so
    -- webhook applies key on it when the owner/name slug no longer matches.
    github_repository_id BIGINT,
    sync_refs         BOOLEAN NOT NULL DEFAULT TRUE,
    sync_metadata     BOOLEAN NOT NULL DEFAULT TRUE,
    sync_state        VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (sync_state IN ('pending', 'syncing', 'ready', 'error', 'failed', 'disabled')),
    enrolled_via      VARCHAR(16) NOT NULL DEFAULT 'lazy'
                      CHECK (enrolled_via IN ('import', 'installation', 'lazy')),
    mirror_owner      VARCHAR(255),
    mirror_repo       VARCHAR(255),
    last_synced_at    TIMESTAMPTZ,
    last_webhook_at   TIMESTAMPTZ,
    syncing_since     TIMESTAMPTZ,
    sync_error        TEXT,
    -- Back-to-back sync failures. Drives the reconciler's exponential backoff
    -- and the 14-strike hard-fail kill switch (sync_state = 'failed').
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_github_synced_repos_github_id
    ON github_synced_repos (github_repository_id)
    WHERE github_repository_id IS NOT NULL;
CREATE UNIQUE INDEX uq_github_synced_repos_slug
    ON github_synced_repos (owner_login_lower, repo_name_lower);
CREATE INDEX idx_github_synced_repos_refs
    ON github_synced_repos (owner_login_lower, repo_name_lower)
    WHERE sync_refs AND sync_state <> 'disabled';
CREATE INDEX idx_github_synced_repos_installation
    ON github_synced_repos (installation_id)
    WHERE installation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS github_synced_issues (
    id                BIGSERIAL PRIMARY KEY,
    synced_repo_id    BIGINT NOT NULL REFERENCES github_synced_repos(id) ON DELETE CASCADE,
    resource          VARCHAR(16) NOT NULL CHECK (resource IN ('issues', 'pulls')),
    number            BIGINT NOT NULL CHECK (number > 0),
    github_id         BIGINT NOT NULL,
    state             VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    title             TEXT NOT NULL DEFAULT '',
    payload           JSONB NOT NULL,
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_github_synced_issues_number
    ON github_synced_issues (synced_repo_id, resource, number);
CREATE INDEX idx_github_synced_issues_listing
    ON github_synced_issues (synced_repo_id, resource, state, github_updated_at DESC);
CREATE INDEX idx_github_synced_issues_listing_created
    ON github_synced_issues (synced_repo_id, resource, state, github_created_at DESC);

CREATE TABLE IF NOT EXISTS github_synced_issue_comments (
    id                BIGSERIAL PRIMARY KEY,
    synced_repo_id    BIGINT NOT NULL REFERENCES github_synced_repos(id) ON DELETE CASCADE,
    issue_number      BIGINT NOT NULL CHECK (issue_number > 0),
    github_id         BIGINT NOT NULL,
    payload           JSONB NOT NULL,
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_github_synced_issue_comments_github_id
    ON github_synced_issue_comments (synced_repo_id, github_id);
CREATE INDEX idx_github_synced_issue_comments_issue
    ON github_synced_issue_comments (synced_repo_id, issue_number, github_created_at);

-- Durable, pollable GitHub mirror runs and their per-ref outcomes.
CREATE TABLE IF NOT EXISTS github_mirror_sync_runs (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    requested_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    state          VARCHAR(16) NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_mirror_sync_runs_repository
    ON github_mirror_sync_runs (repository_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX uq_github_mirror_sync_runs_active
    ON github_mirror_sync_runs (repository_id)
    WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS github_mirror_sync_ref_results (
    id             BIGSERIAL PRIMARY KEY,
    run_id         BIGINT NOT NULL REFERENCES github_mirror_sync_runs(id) ON DELETE CASCADE,
    name           TEXT NOT NULL CHECK (LENGTH(name) BETWEEN 1 AND 1024),
    from_revision  TEXT NOT NULL DEFAULT '',
    to_revision    TEXT NOT NULL DEFAULT '',
    status         VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'succeeded', 'failed')),
    error          TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, name),
    CHECK (from_revision <> '' OR to_revision <> '')
);

CREATE INDEX idx_github_mirror_sync_ref_results_run
    ON github_mirror_sync_ref_results (run_id, name);

-- ---------------------------------------------------------------------------
-- Public sharing: workflow / connector listings + usage stats
-- (migration 20260805120000). Publishing is always explicit; a listing carries
-- the DEFINITION snapshot only, never credentials. Unpublish is a soft delete
-- so the catalog drops it while the owner keeps the stats.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS share_listings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              VARCHAR(16) NOT NULL CHECK (kind IN ('workflow', 'connector')),
    name              VARCHAR(128) NOT NULL CHECK (LENGTH(name) BETWEEN 1 AND 128),
    slug              VARCHAR(160) NOT NULL CHECK (LENGTH(slug) BETWEEN 1 AND 160),
    description       TEXT NOT NULL DEFAULT '',
    owner_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_repo_owner VARCHAR(255) NOT NULL,
    source_repo_name  VARCHAR(255) NOT NULL,
    source_path       TEXT NOT NULL,
    content_snapshot  TEXT NOT NULL,
    use_count         BIGINT NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    install_count     BIGINT NOT NULL DEFAULT 0 CHECK (install_count >= 0),
    published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unpublished_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_share_listings_live_slug
    ON share_listings (kind, slug)
    WHERE unpublished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_share_listings_catalog
    ON share_listings (kind, published_at DESC)
    WHERE unpublished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_share_listings_owner
    ON share_listings (owner_user_id, published_at DESC);

CREATE TABLE IF NOT EXISTS share_listing_event_cooldowns (
    listing_id      UUID NOT NULL REFERENCES share_listings(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type      VARCHAR(16) NOT NULL CHECK (event_type IN ('install', 'run')),
    last_counted_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (listing_id, user_id, event_type)
);

-- Cross-repository changesets: one organization superproject commit pins a
-- vector of member-repository revisions (db/migrations/20260901130000).
CREATE TABLE IF NOT EXISTS changesets (
    id                 BIGSERIAL PRIMARY KEY,
    organization_id    BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    superproject_repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id          VARCHAR(255) NOT NULL,
    commit_id          VARCHAR(255) NOT NULL,
    parent_change_ids  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parent_change_ids) = 'array'),
    target_bookmark    VARCHAR(255) NOT NULL DEFAULT 'main',
    description        TEXT NOT NULL DEFAULT '',
    state              VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'landing', 'landed', 'failed')),
    failure_reason     TEXT NOT NULL DEFAULT '',
    landing_plan       JSONB NOT NULL DEFAULT '{}'::jsonb,
    landed_commit_id   VARCHAR(255) NOT NULL DEFAULT '',
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    landed_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, change_id)
);

CREATE INDEX IF NOT EXISTS idx_changesets_org_created ON changesets (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_changesets_org_state ON changesets (organization_id, state);

CREATE TABLE IF NOT EXISTS changeset_members (
    id                 BIGSERIAL PRIMARY KEY,
    changeset_id       BIGINT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path               VARCHAR(255) NOT NULL,
    change_id          VARCHAR(255) NOT NULL,
    commit_id          VARCHAR(255) NOT NULL,
    target_bookmark    VARCHAR(255) NOT NULL DEFAULT 'main',
    previous_commit_id VARCHAR(255) NOT NULL DEFAULT '',
    landed_commit_id   VARCHAR(255) NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (changeset_id, repository_id),
    UNIQUE (changeset_id, path)
);

CREATE INDEX IF NOT EXISTS idx_changeset_members_repository ON changeset_members (repository_id);

-- smithers build cache hosted per repository (see
-- db/migrations/20260902120000_build_cache.sql): the /ac + /cas protocol the
-- smithers-build CLI speaks, entries in Postgres, artifact bytes in the blob
-- store, every row keyed by repository. Public read tokens are their own kind.
CREATE TABLE IF NOT EXISTS build_cache_entries (
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    key_digest         TEXT NOT NULL CHECK (octet_length(key_digest) BETWEEN 1 AND 512),
    body               TEXT NOT NULL CHECK (octet_length(body) <= 1048576),
    result_canonical   TEXT NOT NULL,
    created_at_ms      BIGINT CHECK (created_at_ms IS NULL OR created_at_ms >= 0),
    recorded_run_id    TEXT CHECK (recorded_run_id IS NULL OR octet_length(recorded_run_id) BETWEEN 1 AND 512),
    recorded_event_seq BIGINT CHECK (recorded_event_seq IS NULL OR recorded_event_seq >= 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (repository_id, key_digest),
    CHECK ((recorded_run_id IS NULL) = (recorded_event_seq IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_build_cache_entries_repo_accessed
    ON build_cache_entries (repository_id, last_accessed_at);

CREATE TABLE IF NOT EXISTS build_cache_artifacts (
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    digest             CHAR(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0),
    gcs_key            TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (repository_id, digest)
);

CREATE INDEX IF NOT EXISTS idx_build_cache_artifacts_repo_accessed
    ON build_cache_artifacts (repository_id, last_accessed_at);

CREATE TABLE IF NOT EXISTS build_cache_entry_artifacts (
    repository_id      BIGINT NOT NULL,
    key_digest         TEXT NOT NULL,
    digest             CHAR(64) NOT NULL,
    PRIMARY KEY (repository_id, key_digest, digest),
    FOREIGN KEY (repository_id, key_digest)
        REFERENCES build_cache_entries(repository_id, key_digest) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, digest)
        REFERENCES build_cache_artifacts(repository_id, digest) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_build_cache_entry_artifacts_digest
    ON build_cache_entry_artifacts (repository_id, digest);

CREATE TABLE IF NOT EXISTS build_cache_read_tokens (
    id                 BIGSERIAL PRIMARY KEY,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name               VARCHAR(255) NOT NULL DEFAULT '',
    token_hash         VARCHAR(64) NOT NULL UNIQUE,
    token_last_eight   VARCHAR(8) NOT NULL DEFAULT '',
    last_used_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_cache_read_tokens_repo_active
    ON build_cache_read_tokens (repository_id) WHERE revoked_at IS NULL;

-- Revocation fan-out (db/migrations/20260902130000_revocation_events.sql):
-- durable event log with a cursor for restarted pods plus NOTIFY 'revocations'
-- for latency. No foreign keys: an event must outlive the row it revokes.
CREATE TABLE IF NOT EXISTS revocation_events (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN (
                        'token_revoked', 'token_scopes_narrowed', 'user_disabled', 'user_enabled',
                        'collaborator_removed', 'workspace_share_removed',
                        'agent_session_cancelled', 'org_member_removed', 'gateway_revoked'
                    )),
    user_id         BIGINT,
    token_id        BIGINT,
    token_hash      TEXT NOT NULL DEFAULT '',
    repository_id   BIGINT,
    organization_id BIGINT,
    workspace_id    TEXT NOT NULL DEFAULT '',
    session_id      TEXT NOT NULL DEFAULT '',
    gateway_id      TEXT NOT NULL DEFAULT '',
    sandbox_ids     TEXT[] NOT NULL DEFAULT '{}'::text[],
    reason          TEXT NOT NULL DEFAULT '',
    actor_id        BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revocation_events_created_at
    ON revocation_events (created_at);

-- Bring-your-own subscriptions (RFD-003): a connected Claude or Codex account
-- whose refresh token stays at rest here and whose access token the egress
-- proxy injects; the guest only ever sees placeholders.
CREATE TABLE IF NOT EXISTS provider_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type              VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'org')),
    user_id                 BIGINT REFERENCES users(id) ON DELETE CASCADE,
    org_id                  BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    provider                VARCHAR(16) NOT NULL CHECK (provider IN ('claude', 'codex')),
    kind                    VARCHAR(16) NOT NULL CHECK (kind IN ('setup_token', 'oauth')),
    label                   VARCHAR(80) NOT NULL DEFAULT '',
    account_email           VARCHAR(255) NOT NULL DEFAULT '',
    account_id              VARCHAR(255) NOT NULL DEFAULT '',
    plan                    VARCHAR(64) NOT NULL DEFAULT '',
    access_token_encrypted  BYTEA NOT NULL,
    refresh_token_encrypted BYTEA,
    access_expires_at       TIMESTAMPTZ,
    state                   VARCHAR(16) NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'refresh_failed', 'revoked')),
    last_refresh_at         TIMESTAMPTZ,
    next_refresh_at         TIMESTAMPTZ,
    refresh_failures        INTEGER NOT NULL DEFAULT 0,
    last_error              TEXT NOT NULL DEFAULT '',
    created_by              BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND org_id IS NULL)
        OR (owner_type = 'org' AND org_id IS NOT NULL AND user_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_provider_connections_user_provider
    ON provider_connections (user_id, provider, updated_at DESC) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_web_request
    ON provider_connections (user_id, label) WHERE owner_type = 'user' AND label LIKE 'web-%';
CREATE INDEX IF NOT EXISTS idx_provider_connections_org_provider
    ON provider_connections (org_id, provider, updated_at DESC) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_provider_connections_refresh_due
    ON provider_connections (next_refresh_at) WHERE state = 'active' AND refresh_token_encrypted IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_connection_grants (
    id               BIGSERIAL PRIMARY KEY,
    connection_id    UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    repository_id    BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
    org_id           BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    all_repositories BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (all_repositories OR repository_id IS NOT NULL OR org_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_provider_connection_grants_connection
    ON provider_connection_grants (connection_id);

-- The existing wiki rows remain the readable projection. Yjs state includes
-- pending causal updates; the revision stream supplies history and durable acks.
ALTER TABLE wiki_pages
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN crdt_state BYTEA,
    ADD COLUMN crdt_vector BYTEA,
    ADD COLUMN last_update_id UUID,
    ADD COLUMN last_update BYTEA,
    ADD CONSTRAINT wiki_crdt_state_pair CHECK ((crdt_state IS NULL) = (crdt_vector IS NULL)),
    ADD CONSTRAINT wiki_crdt_state_size CHECK (octet_length(crdt_state) <= 8388608),
    ADD CONSTRAINT wiki_body_size CHECK (octet_length(body) <= 1048576) NOT VALID;

CREATE TABLE wiki_page_revisions (
    id BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    -- Retain history after deletion; page IDs are never reused on recreation.
    page_id BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    author_username TEXT NOT NULL,
    update_id UUID,
    update_bytes BYTEA,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    history_commit_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (page_id, revision),
    UNIQUE (page_id, update_id)
);
CREATE INDEX idx_wiki_page_revisions_repo ON wiki_page_revisions(repository_id, id);

INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body, author_id, author_username, created_at)
SELECT wp.repository_id, wp.id, wp.revision, wp.slug, wp.title, wp.body, wp.author_id, u.username, wp.updated_at
FROM wiki_pages wp JOIN users u ON u.id = wp.author_id;

CREATE FUNCTION wiki_advance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Initializing causal metadata is not a new human edit. The CAS query
    -- changes only these two fields and never changes author/time/body.
    IF OLD.crdt_state IS NULL AND NEW.crdt_state IS NOT NULL
       AND (to_jsonb(NEW) - 'crdt_state' - 'crdt_vector') =
           (to_jsonb(OLD) - 'crdt_state' - 'crdt_vector') THEN
        RETURN NEW;
    END IF;
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER wiki_advance_revision BEFORE UPDATE ON wiki_pages
FOR EACH ROW EXECUTE FUNCTION wiki_advance_revision();

CREATE FUNCTION wiki_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    page wiki_pages%ROWTYPE;
    cursor_id BIGINT;
    is_deleted BOOLEAN := TG_OP = 'DELETE';
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN
        RETURN NULL;
    END IF;
    IF is_deleted THEN
        -- Parent/user cascades have already removed the referenced row.
        -- Ordinary page deletion retains history; repository deletion removes it.
        IF NOT EXISTS (SELECT 1 FROM repositories WHERE id = OLD.repository_id) THEN
            RETURN NULL;
        END IF;
        page := OLD;
        page.revision := OLD.revision + 1;
        page.last_update_id := NULL;
        page.last_update := NULL;
        page.author_id := COALESCE(NULLIF(current_setting('smithers.wiki_actor_id', true), '')::bigint, OLD.author_id);
    ELSE
        page := NEW;
    END IF;
    INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body,
        author_id, author_username, update_id, update_bytes, deleted)
    VALUES (page.repository_id, page.id, page.revision, page.slug, page.title, page.body,
        CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = page.author_id) THEN page.author_id END, COALESCE((SELECT username FROM users WHERE id = page.author_id), ''),
        page.last_update_id, page.last_update, is_deleted)
    RETURNING id INTO cursor_id;
    -- Only small metadata goes through NOTIFY; clients fetch bounded pages of
    -- committed revisions or the latest CRDT snapshot through authorized REST.
    PERFORM pg_notify('wiki_page_' || page.id, json_build_object(
        'id', page.revision, 'page_id', page.id, 'revision', page.revision,
        'update_id', page.last_update_id, 'deleted', is_deleted)::text);
    RETURN NULL;
END $$;
CREATE TRIGGER wiki_record_revision AFTER INSERT OR UPDATE OR DELETE ON wiki_pages
FOR EACH ROW EXECUTE FUNCTION wiki_record_revision();



-- Token deletion, including cascading application deletion and bulk grant
-- removal, must revoke existing connections in the same transaction.
CREATE FUNCTION revoke_deleted_oauth2_token() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event revocation_events;
BEGIN
    PERFORM pg_advisory_xact_lock(1548769901);
    INSERT INTO revocation_events (kind, user_id, token_hash, reason)
    VALUES ('token_revoked', OLD.user_id, OLD.token_hash, 'OAuth token revoked')
    RETURNING * INTO event;
    PERFORM pg_notify('revocations', json_build_object('id', event.id, 'kind', event.kind,
        'user_id', event.user_id, 'token_hash', event.token_hash)::text);
    RETURN OLD;
END;
$$;
CREATE TRIGGER oauth2_token_revocation AFTER DELETE ON oauth2_access_tokens
FOR EACH ROW EXECUTE FUNCTION revoke_deleted_oauth2_token();

-- A transaction lock serializes edges within a repository; the reachability
-- query runs after that lock so opposite concurrent inserts cannot both pass.
CREATE FUNCTION enforce_issue_dependency_dag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE repo_id bigint;
BEGIN
    SELECT repository_id INTO repo_id FROM issues WHERE id = NEW.issue_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('issue_dependencies:' || repo_id::text, 0));
    IF EXISTS (
        WITH RECURSIVE reachable(id) AS (
            SELECT NEW.depends_on_issue_id
            UNION
            SELECT d.depends_on_issue_id FROM issue_dependencies d JOIN reachable r ON d.issue_id = r.id
        ) SELECT 1 FROM reachable WHERE id = NEW.issue_id
    ) THEN
        RAISE EXCEPTION 'issue dependency would create a cycle'
            USING ERRCODE = '23514', CONSTRAINT = 'issue_dependencies_acyclic';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER issue_dependency_dag BEFORE INSERT OR UPDATE ON issue_dependencies
FOR EACH ROW EXECUTE FUNCTION enforce_issue_dependency_dag();


CREATE TABLE code_search_index_state (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    commit_id TEXT NOT NULL
);

-- Account state and its event commit together. Publishing after UPDATE could
-- reorder concurrent suspend/unsuspend calls or lose an event on process exit.
CREATE FUNCTION publish_user_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    event revocation_events;
    old_enabled boolean := OLD.is_active AND NOT OLD.prohibit_login AND OLD.deleted_at IS NULL;
    new_enabled boolean := NEW.is_active AND NOT NEW.prohibit_login AND NEW.deleted_at IS NULL;
BEGIN
    IF old_enabled IS NOT DISTINCT FROM new_enabled THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(1548769901);
    INSERT INTO revocation_events (kind, user_id, reason)
    VALUES (CASE WHEN new_enabled THEN 'user_enabled' ELSE 'user_disabled' END,
        NEW.id, CASE WHEN new_enabled THEN 'account enabled' ELSE 'account suspended or deleted' END)
    RETURNING * INTO event;
    PERFORM pg_notify('revocations', json_build_object('id', event.id, 'kind', event.kind,
        'user_id', event.user_id)::text);
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_access_revocation AFTER UPDATE OF is_active, prohibit_login, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION publish_user_access_change();

CREATE TABLE sandbox_usage_intervals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sandbox_kind text NOT NULL CHECK (sandbox_kind IN ('workspace', 'gateway', 'agent')),
    sandbox_id text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT sandbox_usage_intervals_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX sandbox_usage_intervals_open
    ON sandbox_usage_intervals (sandbox_kind, sandbox_id) WHERE ended_at IS NULL;
CREATE INDEX sandbox_usage_intervals_user_started
    ON sandbox_usage_intervals (user_id, started_at DESC);

-- Opt-in bindings for current Smithers Control hosts. These are delivery
-- registrations, not a second workflow format; source stays in .smithers/.
CREATE TABLE repository_job_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job text NOT NULL CHECK (job IN ('issues','review','ci','feature','chores')),
    mode text NOT NULL CHECK (mode IN ('trial','enabled')),
    revision bigint NOT NULL CHECK (revision > 0),
    digest text NOT NULL,
    source_revision text NOT NULL,
    flow_id text NOT NULL,
    configuration jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    trial_issue_number bigint NOT NULL DEFAULT 0,
    trial_source text NOT NULL DEFAULT '',
    schedule text NOT NULL DEFAULT '',
    next_fire_at timestamptz,
    activated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, job, mode),
    CHECK (mode <> 'trial' OR (trial_issue_number > 0 AND trial_source IN ('github','smithers-cloud')))
);

-- Admission is written before acknowledging the authenticated upstream job.
-- A trial may be registered after GitHub delivered the newly created issue;
-- retaining the signed event closes that creation/registration race.
CREATE TABLE repository_job_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    delivery_key text NOT NULL,
    source text NOT NULL CHECK (source IN ('github','smithers-cloud')),
    event_type text NOT NULL,
    event_action text NOT NULL,
    issue_number bigint NOT NULL DEFAULT 0,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, delivery_key)
);
CREATE INDEX repository_job_events_repo_received
    ON repository_job_events(repository_id, received_at, id);

-- Plan bytes are retained before Run. Retrying after either HTTP response is
-- lost uses the same Control idempotency keys and the same reviewed envelope.
CREATE TABLE repository_job_dispatches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid NOT NULL REFERENCES repository_job_registrations(id) ON DELETE CASCADE,
    revision bigint NOT NULL,
    digest text NOT NULL,
    delivery_key text NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    event_action text NOT NULL,
    issue_number bigint NOT NULL DEFAULT 0,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dispatching','waiting','submitted','failed','skipped')),
    plan jsonb,
    run_id text NOT NULL DEFAULT '',
    signal_attempt integer NOT NULL DEFAULT 0,
    receipt jsonb,
    claim_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (registration_id, revision, delivery_key)
);
CREATE INDEX repository_job_dispatch_pending
    ON repository_job_dispatches(next_attempt_at, created_at) WHERE status IN ('queued','dispatching','waiting');
CREATE INDEX repository_job_dispatch_issue
    ON repository_job_dispatches(registration_id, revision, source, issue_number, created_at);

-- Native events commit with the source mutation; GitHub mirrors use separate
-- github_synced_* tables. Every committed row mutation has one durable identity.
CREATE OR REPLACE FUNCTION repository_job_native_issue_payload(issue_row issues)
RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username),
    'labels', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',l.name))
      FROM issue_labels il JOIN labels l ON l.id=il.label_id
      WHERE il.issue_id=issue_row.id), '[]'::jsonb))
  FROM users u WHERE u.id=issue_row.author_id
$$;

CREATE OR REPLACE FUNCTION admit_native_repository_job_issue()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  action_name TEXT;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.title,NEW.body,NEW.state) IS NOT DISTINCT FROM (OLD.title,OLD.body,OLD.state) THEN
    RETURN NEW;
  END IF;
  action_name := CASE WHEN TG_OP='INSERT' THEN 'opened'
    WHEN NEW.state<>OLD.state THEN CASE WHEN NEW.state='open' THEN 'reopened' ELSE 'closed' END
    ELSE 'edited' END;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (NEW.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,NEW.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(NEW),
      'repository',jsonb_build_object('id',NEW.repository_id)));
  RETURN NEW;
END $$;

CREATE TRIGGER trg_repository_job_native_issue
AFTER INSERT OR UPDATE OF title,body,state ON issues
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_issue();

CREATE OR REPLACE FUNCTION admit_native_repository_job_comment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  issue_row issues%ROWTYPE;
  comment_row issue_comments%ROWTYPE;
  action_name TEXT;
  actor JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN comment_row:=OLD; action_name:='deleted';
  ELSIF TG_OP='INSERT' THEN comment_row:=NEW; action_name:='created';
  ELSE comment_row:=NEW; action_name:='edited'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=comment_row.issue_id;
  IF NOT FOUND OR comment_row.type<>'comment' THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id',id,'login',username) INTO actor FROM users WHERE id=comment_row.user_id;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issue_comment',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'comment',to_jsonb(comment_row)||jsonb_build_object('user',actor),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_repository_job_native_comment
AFTER INSERT OR UPDATE OF body OR DELETE ON issue_comments
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_comment();

CREATE OR REPLACE FUNCTION admit_native_repository_job_label()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  issue_row issues%ROWTYPE;
  issue_key BIGINT;
  action_name TEXT;
BEGIN
  IF TG_OP='DELETE' THEN issue_key:=OLD.issue_id; action_name:='unlabeled';
  ELSE issue_key:=NEW.issue_id; action_name:='labeled'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=issue_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_repository_job_native_label
AFTER INSERT OR DELETE ON issue_labels
FOR EACH ROW EXECUTE FUNCTION admit_native_repository_job_label();

-- Idempotent setup trials retain the exact request even if its issue is deleted.
CREATE TABLE repository_job_trials (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  job text NOT NULL CHECK (job IN ('issues','review','ci','feature','chores')),
  request_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  digest text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  issue_id bigint REFERENCES issues(id) ON DELETE SET NULL,
  issue_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id,job,request_id)
);

-- Native automatic replies commit with their replay receipt and outbox event.
-- comment_id intentionally survives comment deletion: replay never republishes.
CREATE TABLE repository_job_comments (
    dispatch_id uuid NOT NULL REFERENCES repository_job_dispatches(id) ON DELETE CASCADE,
    step text NOT NULL,
    body text NOT NULL,
    comment_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dispatch_id, step)
);

-- Selected execution identity, not evidence that a guest has started. Gateway
-- health supplies capability proof. Never replace a binding on setup retry.
CREATE TABLE workspace_capability_bindings (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    required_capability text NOT NULL CHECK (required_capability = 'repository-jobs/v1'),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (repository_id, user_id, required_capability),
    UNIQUE (workspace_id, required_capability)
);
CREATE INDEX repository_job_comments_comment ON repository_job_comments(comment_id);
