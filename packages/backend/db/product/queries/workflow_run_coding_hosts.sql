-- name: GetWorkflowRunCodingHost :one
SELECT workflow_run_id, workspace_id, host_run_id, flow_id, created_at, updated_at FROM workflow_run_coding_hosts WHERE workflow_run_id = $1;

-- name: RecordWorkflowRunCodingHost :one

INSERT INTO workflow_run_coding_hosts (workflow_run_id, workspace_id, host_run_id, flow_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workflow_run_id) DO UPDATE
SET workspace_id = EXCLUDED.workspace_id,
    host_run_id  = EXCLUDED.host_run_id,
    flow_id      = EXCLUDED.flow_id,
    updated_at   = NOW()
RETURNING workflow_run_id, workspace_id, host_run_id, flow_id, created_at, updated_at;
