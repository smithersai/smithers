-- name: CreateLinearIntegration :one
INSERT INTO linear_integrations (
    user_id, org_id, linear_team_id, linear_team_name, linear_team_key,
    access_token_encrypted, refresh_token_encrypted, token_expires_at,
    webhook_key, webhook_secret, jjhub_repo_id, jjhub_repo_owner, jjhub_repo_name,
    linear_actor_id, linear_actor_name, linear_actor_email
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
RETURNING *;

-- name: GetLinearIntegration :one
SELECT * FROM linear_integrations WHERE id = $1;

-- name: GetLinearIntegrationByUserAndID :one
SELECT * FROM linear_integrations WHERE id = $1 AND user_id = $2;

-- name: GetLinearIntegrationByLinearTeamID :one
SELECT * FROM linear_integrations
WHERE linear_team_id = $1 AND is_active = TRUE
LIMIT 1;

-- name: GetLinearIntegrationByWebhookKey :one
SELECT * FROM linear_integrations
WHERE webhook_key = $1 AND is_active = TRUE;

-- name: ListLinearIntegrationsByUser :many
SELECT * FROM linear_integrations
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: ListLinearIntegrationsByRepo :many
SELECT * FROM linear_integrations
WHERE jjhub_repo_id = $1 AND is_active = TRUE
ORDER BY created_at DESC;

-- name: ListActiveLinearIntegrations :many
SELECT * FROM linear_integrations
WHERE is_active = TRUE
ORDER BY id;

-- name: UpdateLinearIntegrationTokens :exec
UPDATE linear_integrations
SET access_token_encrypted = $2,
    refresh_token_encrypted = $3,
    token_expires_at = $4,
    updated_at = NOW()
WHERE id = $1;

-- name: UpdateLinearIntegrationLastSync :exec
UPDATE linear_integrations
SET last_sync_at = NOW(),
    updated_at = NOW()
WHERE id = $1;

-- name: UpdateLinearIntegrationActive :exec
UPDATE linear_integrations
SET is_active = $2,
    updated_at = NOW()
WHERE id = $1;

-- name: DeleteLinearIntegration :exec
DELETE FROM linear_integrations WHERE id = $1 AND user_id = $2;

-- name: CreateLinearIssueMap :one
INSERT INTO linear_issue_map (
    integration_id, jjhub_issue_id, jjhub_issue_number,
    linear_issue_id, linear_identifier
)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetLinearIssueMapBySmithersIssue :one
SELECT * FROM linear_issue_map
WHERE integration_id = $1 AND jjhub_issue_id = $2;

-- name: GetLinearIssueMapBySmithersIssueID :one
SELECT * FROM linear_issue_map
WHERE jjhub_issue_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: GetLinearIssueMapByLinearIssue :one
SELECT * FROM linear_issue_map
WHERE integration_id = $1 AND linear_issue_id = $2;

-- name: ListLinearIssueMaps :many
SELECT * FROM linear_issue_map
WHERE integration_id = $1
ORDER BY created_at DESC;

-- name: DeleteLinearIssueMapByID :execrows
DELETE FROM linear_issue_map WHERE id = $1;

-- name: CreateLinearCommentMap :one
INSERT INTO linear_comment_map (issue_map_id, jjhub_comment_id, linear_comment_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetLinearCommentMapBySmithersComment :one
SELECT * FROM linear_comment_map
WHERE issue_map_id = $1 AND jjhub_comment_id = $2;

-- name: GetLinearCommentMapByLinearComment :one
SELECT * FROM linear_comment_map
WHERE issue_map_id = $1 AND linear_comment_id = $2;

-- name: DeleteLinearCommentMapBySmithersComment :exec
DELETE FROM linear_comment_map
WHERE issue_map_id = $1 AND jjhub_comment_id = $2;

-- name: DeleteLinearCommentMapByLinearComment :exec
DELETE FROM linear_comment_map
WHERE issue_map_id = $1 AND linear_comment_id = $2;

-- name: LogLinearSyncOp :one
INSERT INTO linear_sync_ops (
    integration_id, run_id, source, target, entity, entity_id, action, status, error_message, payload
)
VALUES (
    sqlc.arg(integration_id), sqlc.narg(run_id), sqlc.arg(source), sqlc.arg(target),
    sqlc.arg(entity), sqlc.arg(entity_id), sqlc.arg(action), sqlc.arg(status),
    sqlc.arg(error_message), COALESCE(sqlc.narg(payload)::jsonb, '{}'::jsonb)
)
RETURNING *;

-- name: ListLinearSyncOps :many
SELECT *
FROM linear_sync_ops
WHERE integration_id = sqlc.arg(integration_id)
  AND (sqlc.arg(status_filter)::text = '' OR status = sqlc.arg(status_filter)::text)
  AND (sqlc.narg(since)::timestamptz IS NULL OR created_at >= sqlc.narg(since)::timestamptz)
  AND (
      sqlc.narg(cursor_created_at)::timestamptz IS NULL
      OR (created_at, id) < (
          sqlc.narg(cursor_created_at)::timestamptz,
          sqlc.narg(cursor_id)::bigint
      )
  )
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GetLinearSyncOp :one
SELECT *
FROM linear_sync_ops
WHERE id = sqlc.arg(id) AND integration_id = sqlc.arg(integration_id);

-- name: CreateLinearSyncOpRetry :one
INSERT INTO linear_sync_ops (
    integration_id, retry_of_id, source, target, entity, entity_id,
    action, status, error_message, payload
)
SELECT original.integration_id, original.id, original.source, original.target,
       original.entity, original.entity_id, original.action, 'pending', '', original.payload
FROM linear_sync_ops AS original
WHERE original.id = sqlc.arg(op_id)
  AND original.integration_id = sqlc.arg(integration_id)
  AND original.status = 'failed'
RETURNING *;

-- name: CompleteLinearSyncOpRetry :one
UPDATE linear_sync_ops
SET status = sqlc.arg(status), error_message = sqlc.arg(error_message)
WHERE id = sqlc.arg(id) AND status = 'pending'
RETURNING *;

-- name: RecentLinearSyncOpExists :one
SELECT EXISTS (
    SELECT 1 FROM linear_sync_ops
    WHERE integration_id = $1
      AND entity = $2
      AND entity_id = $3
      AND action = $4
      AND status = 'success'
      AND created_at > NOW() - INTERVAL '5 seconds'
) AS exists;

-- name: CreateLinearSyncRun :one
INSERT INTO linear_sync_runs (integration_id)
VALUES ($1)
RETURNING *;

-- name: GetLinearSyncRun :one
SELECT *
FROM linear_sync_runs
WHERE id = sqlc.arg(id) AND integration_id = sqlc.arg(integration_id);

-- name: MarkLinearSyncRunRunning :one
UPDATE linear_sync_runs
SET state = 'running', started_at = NOW()
WHERE id = $1 AND state = 'pending'
RETURNING *;

-- name: SetLinearSyncRunTotals :one
UPDATE linear_sync_runs
SET issues_total = sqlc.arg(issues_total),
    comments_total = sqlc.arg(comments_total)
WHERE id = sqlc.arg(id) AND state = 'running'
RETURNING *;

-- name: RecordLinearSyncRunResult :one
UPDATE linear_sync_runs
SET issues_done = issues_done + CASE
        WHEN sqlc.arg(entity)::text = 'issue' AND NOT sqlc.arg(failed)::boolean THEN 1 ELSE 0 END,
    issues_failed = issues_failed + CASE
        WHEN sqlc.arg(entity)::text = 'issue' AND sqlc.arg(failed)::boolean THEN 1 ELSE 0 END,
    comments_done = comments_done + CASE
        WHEN sqlc.arg(entity)::text = 'comment' AND NOT sqlc.arg(failed)::boolean THEN 1 ELSE 0 END,
    comments_failed = comments_failed + CASE
        WHEN sqlc.arg(entity)::text = 'comment' AND sqlc.arg(failed)::boolean THEN 1 ELSE 0 END
WHERE id = sqlc.arg(id) AND state = 'running'
RETURNING *;

-- name: FinishLinearSyncRun :one
UPDATE linear_sync_runs
SET state = CASE
        WHEN issues_failed > 0 OR comments_failed > 0 THEN 'failed'
        ELSE 'completed'
    END,
    finished_at = NOW()
WHERE id = $1 AND state = 'running'
RETURNING *;

-- name: FailLinearSyncRun :one
UPDATE linear_sync_runs
SET state = 'failed', finished_at = NOW()
WHERE id = $1 AND state IN ('pending', 'running')
RETURNING *;

-- name: GetLinearCommentMapBySmithersCommentID :one
SELECT lcm.*
FROM linear_comment_map lcm
JOIN linear_issue_map lim ON lim.id = lcm.issue_map_id
WHERE lim.integration_id = sqlc.arg(integration_id)
  AND lcm.jjhub_comment_id = sqlc.arg(jjhub_comment_id);

-- name: GetLinearIssueMapBySmithersCommentID :one
SELECT lim.*
FROM linear_issue_map lim
JOIN linear_comment_map lcm ON lcm.issue_map_id = lim.id
WHERE lim.integration_id = sqlc.arg(integration_id)
  AND lcm.jjhub_comment_id = sqlc.arg(jjhub_comment_id);
