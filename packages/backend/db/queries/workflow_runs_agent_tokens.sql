-- name: UpdateWorkflowRunAgentToken :one
UPDATE workflow_runs
SET agent_token_hash = sqlc.arg(agent_token_hash),
    agent_token_expires_at = sqlc.arg(agent_token_expires_at),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: GetWorkflowRunByAgentToken :one
SELECT *
FROM workflow_runs
WHERE agent_token_hash = sqlc.arg(agent_token_hash);
