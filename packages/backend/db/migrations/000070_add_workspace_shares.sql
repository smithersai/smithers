-- Workspace shares: grants a non-owner user access to a workspace.
-- A row here is a prerequisite for RequireWorkspaceAccess to admit a
-- non-owner requester. There is intentionally no "admin" level.
CREATE TABLE IF NOT EXISTS workspace_shares (
    id              BIGSERIAL PRIMARY KEY,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grantee_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level           VARCHAR(8) NOT NULL DEFAULT 'read'
                    CHECK (level IN ('read', 'write')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, grantee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_shares_grantee ON workspace_shares (grantee_user_id, workspace_id);
