-- name: UpsertProtectedBookmark :one
INSERT INTO protected_bookmarks (
    repository_id,
    pattern,
    require_review,
    require_human_approvals,
    require_agent_lgtm,
    required_checks,
    require_status_checks,
    required_status_contexts,
    dismiss_stale_reviews,
    restrict_push_teams
)
VALUES (
    sqlc.arg(repository_id),
    sqlc.arg(pattern),
    sqlc.arg(require_review),
    sqlc.arg(require_human_approvals),
    sqlc.arg(require_agent_lgtm),
    COALESCE(sqlc.arg(required_checks)::text[], '{}'::text[]),
    sqlc.arg(require_status_checks),
    COALESCE(sqlc.arg(required_status_contexts)::text[], '{}'::text[]),
    sqlc.arg(dismiss_stale_reviews),
    COALESCE(sqlc.arg(restrict_push_teams)::text[], '{}'::text[])
)
ON CONFLICT (repository_id, pattern)
DO UPDATE SET
    require_review = EXCLUDED.require_review,
    require_human_approvals = EXCLUDED.require_human_approvals,
    require_agent_lgtm = EXCLUDED.require_agent_lgtm,
    required_checks = EXCLUDED.required_checks,
    require_status_checks = EXCLUDED.require_status_checks,
    required_status_contexts = EXCLUDED.required_status_contexts,
    dismiss_stale_reviews = EXCLUDED.dismiss_stale_reviews,
    restrict_push_teams = EXCLUDED.restrict_push_teams,
    updated_at = NOW()
RETURNING *;

-- name: ListProtectedBookmarksByRepo :many
SELECT *
FROM protected_bookmarks
WHERE repository_id = $1
ORDER BY pattern ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListAllProtectedBookmarksByRepo :many
SELECT *
FROM protected_bookmarks
WHERE repository_id = $1
ORDER BY pattern ASC;

-- name: DeleteProtectedBookmarkByPattern :execrows
DELETE FROM protected_bookmarks
WHERE repository_id = $1
  AND pattern = $2;
