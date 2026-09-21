-- A bound gateway is a process in an existing user-owned workspace, not another VM.
ALTER TABLE repo_gateways ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
DROP INDEX uq_repo_gateways_active;
CREATE UNIQUE INDEX uq_repo_gateways_active
    ON repo_gateways (repository_id, user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE deleted_at IS NULL AND status IN ('starting', 'running', 'suspended');
