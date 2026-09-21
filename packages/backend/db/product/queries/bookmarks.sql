-- name: UpsertBookmark :one
INSERT INTO bookmarks (repository_id, name, target_change_id, is_default)
VALUES ($1, $2, $3, $4)
ON CONFLICT (repository_id, name)
DO UPDATE SET
    target_change_id = EXCLUDED.target_change_id,
    is_default = EXCLUDED.is_default,
    updated_at = NOW()
RETURNING *;

-- name: SetDefaultBookmark :one
SELECT set_default_bookmark(sqlc.arg(repository_id), sqlc.arg(name));

-- name: CountBookmarksByRepo :one
SELECT COUNT(*)
FROM bookmarks
WHERE repository_id = $1;

-- name: GetRepositoryBookmarkCommitID :one
-- Workflow jobs that span independently materialized tasks must pin one Git
-- revision. Resolve the authoritative bookmark's current change to its exact
-- commit while dispatch is being prepared; callers fail closed if repository
-- metadata has not caught up enough to provide that immutable identity.
SELECT c.commit_id
FROM bookmarks AS b
JOIN changes AS c
  ON c.repository_id = b.repository_id
 AND c.change_id = b.target_change_id
WHERE b.repository_id = sqlc.arg(repository_id)
  AND b.name = sqlc.arg(bookmark_name)
  AND BTRIM(c.commit_id) <> '';

-- name: ListDefaultBookmarkHeadsByRepoIDs :many
-- Resolve default bookmark heads for repository-list responses in one query.
-- A repository whose bookmark metadata has not been synchronized yet is
-- intentionally absent; callers represent that state with empty identifiers.
SELECT
    r.id AS repository_id,
    b.target_change_id AS change_id,
    COALESCE(c.commit_id, '')::text AS commit_id
FROM repositories AS r
JOIN bookmarks AS b
  ON b.repository_id = r.id
 AND b.name = r.default_bookmark
LEFT JOIN changes AS c
  ON c.repository_id = b.repository_id
 AND c.change_id = b.target_change_id
WHERE r.id = ANY(sqlc.arg(repository_ids)::bigint[]);

-- name: ListBookmarksByRepo :many
SELECT *
FROM bookmarks
WHERE repository_id = $1
ORDER BY name ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: DeleteBookmarkByName :execrows
DELETE FROM bookmarks
WHERE repository_id = $1
  AND name = $2;
