ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_fork BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS parent_workspace_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE is_fork = FALSE
      AND status IN ('pending', 'starting', 'running', 'suspended');

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
