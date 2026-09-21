-- name: StarRepo :one
-- DO NOTHING (rather than erroring) on a concurrent duplicate star: no row is
-- returned, callers treat that as already-starred and skip counter/webhook
-- side effects. repositories.num_stars is maintained by trg_stars_count_*.
INSERT INTO stars (user_id, repository_id)
VALUES ($1, $2)
ON CONFLICT (user_id, repository_id) DO NOTHING
RETURNING *;

-- name: UnstarRepo :execrows
-- Returns rows affected so callers only emit star webhooks when this call
-- actually removed the row (concurrent unstars race to a single winner).
DELETE FROM stars
WHERE user_id = $1
  AND repository_id = $2;

-- name: WatchRepo :one
-- repositories.num_watches is maintained by trg_watches_count_ins, which only
-- fires on the insert arm of this upsert — a mode change never recounts.
INSERT INTO watches (user_id, repository_id, mode)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, repository_id)
DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()
RETURNING *;

-- name: UnwatchRepo :execrows
DELETE FROM watches
WHERE user_id = $1
  AND repository_id = $2;

-- name: IsRepoStarred :one
SELECT EXISTS (
    SELECT 1
    FROM stars
    WHERE user_id = sqlc.arg(user_id)
      AND repository_id = sqlc.arg(repository_id)
);

-- name: ListUserStarredRepos :many
SELECT r.*
FROM stars s
JOIN repositories r ON r.id = s.repository_id
WHERE s.user_id = sqlc.arg(user_id)
ORDER BY s.created_at DESC, s.id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountUserStarredRepos :one
SELECT COUNT(*)
FROM stars
WHERE user_id = sqlc.arg(user_id);

-- name: ListPublicUserStarredRepos :many
SELECT r.*
FROM stars s
JOIN repositories r ON r.id = s.repository_id
WHERE s.user_id = sqlc.arg(user_id)
  AND r.is_public = TRUE
ORDER BY s.created_at DESC, s.id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountPublicUserStarredRepos :one
SELECT COUNT(*)
FROM stars s
JOIN repositories r ON r.id = s.repository_id
WHERE s.user_id = sqlc.arg(user_id)
  AND r.is_public = TRUE;

-- name: ListRepoStargazers :many
SELECT u.*
FROM stars s
JOIN users u ON u.id = s.user_id
WHERE s.repository_id = sqlc.arg(repository_id)
ORDER BY u.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: ListRepoWatchers :many
SELECT
    u.*,
    w.mode
FROM watches w
JOIN users u ON u.id = w.user_id
WHERE w.repository_id = sqlc.arg(repository_id)
ORDER BY u.id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: GetWatchStatus :one
SELECT *
FROM watches
WHERE user_id = sqlc.arg(user_id)
  AND repository_id = sqlc.arg(repository_id);

-- name: CountRepoStars :one
SELECT COUNT(*)
FROM stars
WHERE repository_id = $1;

-- name: CountRepoWatchers :one
SELECT COUNT(*)
FROM watches
WHERE repository_id = $1;

-- name: ListUserWatchedRepos :many
SELECT
    r.*,
    w.mode AS watch_mode
FROM watches w
JOIN repositories r ON r.id = w.repository_id
WHERE w.user_id = sqlc.arg(user_id)
ORDER BY w.updated_at DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountUserWatchedRepos :one
SELECT COUNT(*)
FROM watches
WHERE user_id = sqlc.arg(user_id);

-- name: ListActiveWatchersForRepo :many
-- Returns all users watching a repo with mode 'watching' or 'participating'.
-- Used to fan-out notifications when new issues or landing requests are opened.
SELECT u.id, u.email_notifications_enabled
FROM watches w
JOIN users u ON u.id = w.user_id
WHERE w.repository_id = sqlc.arg(repository_id)
  AND w.mode IN ('watching', 'participating')
ORDER BY u.id ASC;
