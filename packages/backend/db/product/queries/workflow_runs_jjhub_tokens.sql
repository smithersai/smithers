-- name: UpdateWorkflowRunJJHubTokenID :exec
UPDATE workflow_runs
SET jjhub_token_id = sqlc.arg(jjhub_token_id),
    updated_at = NOW()
WHERE id = sqlc.arg(id);

-- name: GetWorkflowRunJJHubTokenID :one
SELECT jjhub_token_id
FROM workflow_runs
WHERE id = sqlc.arg(id);

-- name: ClearWorkflowRunJJHubTokenID :exec
UPDATE workflow_runs
SET jjhub_token_id = NULL,
    updated_at = NOW()
WHERE id = sqlc.arg(id);
