ALTER TABLE workflow_tasks
    ADD COLUMN IF NOT EXISTS freestyle_vm_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_freestyle_vm_id
    ON workflow_tasks (freestyle_vm_id)
    WHERE freestyle_vm_id IS NOT NULL;

ALTER TABLE workspaces
    DROP COLUMN IF EXISTS agent_token_hash,
    DROP COLUMN IF EXISTS pod_name,
    DROP COLUMN IF EXISTS pvc_name,
    ADD COLUMN IF NOT EXISTS freestyle_vm_id TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active ON workspaces (repository_id, user_id)
    WHERE status IN ('pending', 'starting', 'running', 'suspended');

DROP INDEX IF EXISTS idx_workspaces_status;
CREATE INDEX idx_workspaces_status ON workspaces (status)
    WHERE status IN ('pending', 'starting', 'running', 'suspended');

ALTER TABLE workspaces
    DROP CONSTRAINT IF EXISTS workspaces_status_check;

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_status_check
    CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed'));

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
