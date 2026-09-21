-- name: GetPairStateForUpdate :one
SELECT state, version FROM pair_state WHERE room_id = $1 FOR UPDATE;

-- name: GetPairState :one
SELECT state, version FROM pair_state WHERE room_id = $1;

-- name: UpsertPairState :exec
INSERT INTO pair_state (room_id, state, version, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (room_id) DO UPDATE
    SET state = EXCLUDED.state,
        version = EXCLUDED.version,
        updated_at = NOW();

-- name: NotifyPairRoom :exec
SELECT pg_notify('pair_room_' || sqlc.arg(room_id)::text, sqlc.arg(payload)::text);

-- name: CreatePairShareLink :one
INSERT INTO pair_share_links (token_hash, room_id, level, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetPairShareLinkByTokenHash :one
SELECT * FROM pair_share_links
WHERE token_hash = $1
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > NOW());

-- name: RevokePairShareLink :execrows
UPDATE pair_share_links
SET revoked_at = NOW()
WHERE id = sqlc.arg(id)
  AND created_by = sqlc.arg(created_by)
  AND revoked_at IS NULL;

-- name: ListPairShareLinksByRoom :many
SELECT * FROM pair_share_links
WHERE room_id = $1 AND revoked_at IS NULL
ORDER BY created_at DESC;
