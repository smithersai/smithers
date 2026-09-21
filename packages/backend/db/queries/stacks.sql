-- Active-stack tracking (stacked changes submitted from the CLI).
--
-- stack_changes carries UNIQUE (stack_id, position) DEFERRABLE INITIALLY
-- DEFERRED, so reorders that swap existing positions must run the per-row
-- upserts and the prune inside one transaction (StackService.SubmitActiveStack
-- does); the constraint is then checked once at commit instead of per row.

-- name: GetActiveStack :one
SELECT *
FROM stacks
WHERE repository_id = $1
  AND user_id = $2
  AND target_ref = $3
  AND state = 'active'
LIMIT 1;

-- name: UpsertActiveStack :one
INSERT INTO stacks (repository_id, user_id, target_ref, state)
VALUES ($1, $2, $3, 'active')
ON CONFLICT (repository_id, user_id, target_ref, state)
DO UPDATE SET
    updated_at = NOW()
RETURNING *;

-- name: ListStacksByRepository :many
SELECT *
FROM stacks
WHERE repository_id = $1
ORDER BY created_at DESC, id DESC;

-- name: DeleteStackByID :exec
DELETE FROM stacks
WHERE id = $1;

-- name: UpsertStackChange :one
INSERT INTO stack_changes (
    stack_id,
    change_id,
    position,
    branch_name,
    pr_number,
    pr_state,
    review_status,
    ci_status
)
VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8
)
ON CONFLICT (stack_id, change_id)
DO UPDATE SET
    position = EXCLUDED.position,
    branch_name = EXCLUDED.branch_name,
    pr_number = EXCLUDED.pr_number,
    pr_state = EXCLUDED.pr_state,
    review_status = EXCLUDED.review_status,
    ci_status = EXCLUDED.ci_status,
    updated_at = NOW()
RETURNING *;

-- name: ListStackChangesByStack :many
SELECT *
FROM stack_changes
WHERE stack_id = $1
ORDER BY position ASC, id ASC;

-- name: DeleteStackChangesNotInSet :exec
DELETE FROM stack_changes
WHERE stack_id = sqlc.arg(stack_id)
  AND NOT (change_id = ANY(sqlc.arg(change_ids)::text[]));

-- name: DeleteAllStackChanges :exec
DELETE FROM stack_changes
WHERE stack_id = $1;

-- name: GetGitHubAppInstallationForOwnerRepo :one
SELECT installation_id
FROM github_app_installation_repositories
WHERE owner_login_lower = sqlc.arg(owner)
  AND repo_name_lower = sqlc.arg(repo)
LIMIT 1;
