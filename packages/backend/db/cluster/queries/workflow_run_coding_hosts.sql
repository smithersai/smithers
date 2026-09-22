-- Private cluster queries kept separate from the product graph.

-- name: RecordWorkflowRunCodingHost :one
-- Written once the workspace gateway accepts a dispatched turn. A retry of the
-- same dispatch re-asserts the same identity rather than creating a second row.
INSERT INTO workflow_run_coding_hosts (workflow_run_id, workspace_id, host_run_id, flow_id)
VALUES (sqlc.arg(workflow_run_id), sqlc.arg(workspace_id), sqlc.arg(host_run_id), sqlc.arg(flow_id))
ON CONFLICT (workflow_run_id) DO UPDATE
SET workspace_id = EXCLUDED.workspace_id,
    host_run_id  = EXCLUDED.host_run_id,
    flow_id      = EXCLUDED.flow_id,
    updated_at   = NOW()
RETURNING *;


-- name: GetWorkflowRunCodingHost :one
SELECT * FROM workflow_run_coding_hosts WHERE workflow_run_id = sqlc.arg(workflow_run_id);
