-- name: CreateLFSObject :one
INSERT INTO lfs_objects (repository_id, oid, size, gcs_path)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetLFSObjectByOID :one
SELECT *
FROM lfs_objects
WHERE repository_id = $1
  AND oid = $2;

-- name: ListLFSObjects :many
SELECT *
FROM lfs_objects
WHERE repository_id = $1
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountLFSObjects :one
SELECT COUNT(*)
FROM lfs_objects
WHERE repository_id = $1;

-- name: DeleteLFSObject :execrows
-- Exact-identity metadata CAS. The user-facing delete path must distinguish a
-- successful removal from a stale/repeated delete after it has purged the blob.
DELETE FROM lfs_objects
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND oid = sqlc.arg(oid);

-- name: UpsertLFSUploadReservation :one
INSERT INTO lfs_upload_reservations (repository_id, oid, size, expires_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (repository_id, oid) DO UPDATE
SET size = EXCLUDED.size,
    -- Never shorten the fence for a capability issued by an older process
    -- with a longer configured lifetime. A config-lowering restart may
    -- refresh the same deterministic pending key while that older signed URL
    -- is still usable.
    expires_at = GREATEST(lfs_upload_reservations.expires_at, EXCLUDED.expires_at),
    updated_at = NOW()
RETURNING *;

-- name: GetLFSUploadReservation :one
SELECT *
FROM lfs_upload_reservations
WHERE repository_id = $1
  AND oid = $2;

-- name: DeleteLFSUploadReservation :exec
DELETE FROM lfs_upload_reservations
WHERE repository_id = $1
  AND oid = $2;

-- name: DeleteUnissuedLFSUploadReservation :execrows
-- Signer-failure rollback only. Match the complete reservation snapshot so a
-- refresh/replacement that may own an escaped capability is never removed.
DELETE FROM lfs_upload_reservations
WHERE repository_id = sqlc.arg(repository_id)::bigint
  AND oid = sqlc.arg(oid)::text
  AND size = sqlc.arg(size)::bigint
  AND expires_at = sqlc.arg(expires_at)::timestamptz
  AND created_at = sqlc.arg(created_at)::timestamptz
  AND updated_at = sqlc.arg(updated_at)::timestamptz;

-- name: ListExpiredLFSUploadReservationsByOwner :many
SELECT lur.*
FROM lfs_upload_reservations lur
-- The caller holds only this repository's ownership lock through physical
-- deletion. Selecting owner siblings here would let one of those repositories
-- transfer and refresh its upload while cleanup removes its bytes.
WHERE lur.repository_id = sqlc.arg(repository_id)
  AND lur.expires_at <= NOW()
ORDER BY lur.oid
LIMIT 256;

-- name: DeleteExpiredLFSUploadReservation :execrows
DELETE FROM lfs_upload_reservations
WHERE repository_id = $1
  AND oid = $2
  AND expires_at <= NOW();

-- name: CreateLFSLock :one
INSERT INTO lfs_locks (repository_id, path, owner_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetLFSLockByPath :one
SELECT *
FROM lfs_locks
WHERE repository_id = $1
  AND path = $2;

-- name: ListLFSLocks :many
SELECT *
FROM lfs_locks
WHERE repository_id = $1
ORDER BY id ASC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: CountLFSLocks :one
SELECT COUNT(*)
FROM lfs_locks
WHERE repository_id = $1;

-- name: DeleteLFSLockByID :exec
DELETE FROM lfs_locks
WHERE repository_id = $1
  AND id = $2;

-- name: DeleteLFSLockByPath :exec
DELETE FROM lfs_locks
WHERE repository_id = $1
  AND path = $2;
