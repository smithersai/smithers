-- Product queries extracted from the transitional Plue source.

-- name: IsStorageDeletionObjectActive :one
-- LFS names are the only reusable object namespace. Decode their durable
-- allocation identity once, then probe the indexed (repository_id, oid)
-- constraints. Non-LFS allocations return false without scanning either LFS
-- table, and legacy/custom final gcs_path values remain protected by the same
-- authoritative repository+OID identity.
WITH lfs_allocation AS (
    SELECT split_part(sqlc.arg(allocation_key)::text, ':', 3) AS oid
    WHERE split_part(sqlc.arg(allocation_key)::text, ':', 1) = 'lfs'
      AND split_part(sqlc.arg(allocation_key)::text, ':', 2) = sqlc.arg(repository_id)::bigint::text
      AND split_part(sqlc.arg(allocation_key)::text, ':', 3) <> ''
      AND split_part(sqlc.arg(allocation_key)::text, ':', 4) = ''
)
SELECT EXISTS (
    SELECT 1
    FROM lfs_allocation AS allocation
    WHERE EXISTS (
        SELECT 1
        FROM lfs_objects AS lo
        WHERE lo.repository_id = sqlc.arg(repository_id)::bigint
          AND lo.oid = allocation.oid
    ) OR EXISTS (
        SELECT 1
        FROM lfs_upload_reservations AS lur
        WHERE lur.repository_id = sqlc.arg(repository_id)::bigint
          AND lur.oid = allocation.oid
    )
)::boolean;

