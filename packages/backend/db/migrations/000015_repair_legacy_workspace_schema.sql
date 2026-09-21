-- Repair legacy databases created before workspace-era tables and repository
-- credentials were moved into the baseline migration. This migration is
-- guarded so it is safe on fresh installs and partially migrated databases.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS storage_set_id VARCHAR(50);

UPDATE repositories
SET storage_set_id = 's1'
WHERE storage_set_id IS NULL OR storage_set_id = '';

ALTER TABLE repositories
    ALTER COLUMN storage_set_id SET NOT NULL;

ALTER TABLE workflow_tasks
    ADD COLUMN IF NOT EXISTS freestyle_vm_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_freestyle_vm_id
    ON workflow_tasks (freestyle_vm_id)
    WHERE freestyle_vm_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspaces (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id       BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL DEFAULT '',
    is_fork             BOOLEAN NOT NULL DEFAULT FALSE,
    parent_workspace_id TEXT NOT NULL DEFAULT '',
    source_snapshot_id  TEXT NOT NULL DEFAULT '',
    freestyle_vm_id     TEXT NOT NULL DEFAULT '',
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs   INTEGER NOT NULL DEFAULT 1800,
    suspended_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workspaces_status_check
        CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed'))
);

ALTER TABLE workspaces
    DROP COLUMN IF EXISTS agent_token_hash,
    DROP COLUMN IF EXISTS pod_name,
    DROP COLUMN IF EXISTS pvc_name,
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_fork BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS parent_workspace_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS freestyle_vm_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

ALTER TABLE workspaces
    DROP CONSTRAINT IF EXISTS workspaces_status_check;

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_status_check
    CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed'));

DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE is_fork = FALSE
      AND status IN ('pending', 'starting', 'running', 'suspended');

DROP INDEX IF EXISTS idx_workspaces_status;
CREATE INDEX idx_workspaces_status ON workspaces (status)
    WHERE status IN ('pending', 'starting', 'running', 'suspended');

CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id         BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id          TEXT NOT NULL DEFAULT '',
    name                  TEXT NOT NULL,
    freestyle_snapshot_id TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_repo_id
    ON workspace_snapshots (repository_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_workspace_id
    ON workspace_snapshots (workspace_id);

CREATE TABLE IF NOT EXISTS workspace_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id       BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ssh_connection_info JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    cols                INTEGER NOT NULL DEFAULT 80,
    rows                INTEGER NOT NULL DEFAULT 24,
    last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_timeout_secs   INTEGER NOT NULL DEFAULT 1800,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workspace_sessions_status_check
        CHECK (status IN ('pending', 'starting', 'running', 'stopped', 'failed')),
    CONSTRAINT workspace_sessions_ssh_connection_info_check
        CHECK (jsonb_typeof(ssh_connection_info) = 'object')
);

ALTER TABLE workspace_sessions
    DROP COLUMN IF EXISTS client_sdp,
    DROP COLUMN IF EXISTS runner_sdp,
    DROP COLUMN IF EXISTS client_ice_candidates,
    DROP COLUMN IF EXISTS runner_ice_candidates,
    ADD COLUMN IF NOT EXISTS ssh_connection_info JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workspace_sessions
    DROP CONSTRAINT IF EXISTS workspace_sessions_ssh_connection_info_check;

ALTER TABLE workspace_sessions
    ADD CONSTRAINT workspace_sessions_ssh_connection_info_check
    CHECK (jsonb_typeof(ssh_connection_info) = 'object');

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_repo_id
    ON workspace_sessions (repository_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_user_id
    ON workspace_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_workspace_id
    ON workspace_sessions (workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_status
    ON workspace_sessions (status)
    WHERE status IN ('pending', 'starting', 'running');

CREATE TABLE IF NOT EXISTS repository_secrets (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);

CREATE INDEX IF NOT EXISTS idx_repository_secrets_repo_id
    ON repository_secrets (repository_id);

CREATE TABLE IF NOT EXISTS repository_variables (
    id            BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    value         TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);

CREATE INDEX IF NOT EXISTS idx_repository_variables_repo_id
    ON repository_variables (repository_id);
