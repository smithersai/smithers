-- Private cluster queries kept separate from the product graph.

-- name: ClaimStorageDeletions :many
-- Claim due rows in a short transaction. Each row is subsequently re-locked
-- with LockClaimedStorageDeletion while its exact key is physically purged.
WITH candidates AS (
    SELECT id
    FROM storage_deletion_queue
    WHERE COALESCE(requested_delete_after, delete_after) <= NOW()
      AND (
          requested_delete_after IS NULL
          OR COALESCE((
              SELECT isfinite(horizon.valid_until)
                     AND horizon.valid_until <= clock_timestamp()
              FROM storage_legacy_capability_horizons AS horizon
              WHERE horizon.capability_kind = 'legacy-final-key-upload'
          ), FALSE)
      )
      AND (
          claim_token IS NULL
          OR claimed_at <= NOW() - make_interval(secs => sqlc.arg(lease_seconds)::int)
      )
    ORDER BY delete_after ASC, id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT sqlc.arg(limit_rows)
)
UPDATE storage_deletion_queue AS queue
SET claim_token = sqlc.arg(claim_token),
    claimed_at = NOW(),
    updated_at = NOW()
FROM candidates
WHERE queue.id = candidates.id
RETURNING queue.*;


-- name: LockClaimedStorageDeletion :one
-- The LFS re-admission triggers delete matching queue rows. Holding this row
-- lock across the object-store purge makes a fresh reservation wait until the
-- old bytes are gone, or win first and make this lookup return no row.
SELECT *
FROM storage_deletion_queue
WHERE id = sqlc.arg(id)
  AND claim_token = sqlc.arg(claim_token)
FOR UPDATE;


-- name: DeleteClaimedStorageDeletion :execrows
DELETE FROM storage_deletion_queue
WHERE id = sqlc.arg(id)
  AND claim_token = sqlc.arg(claim_token);


-- name: ClearPurgedStorageDeletionByExactKey :execrows
-- Signer-failure rollback is the sole caller: the object key has already been
-- hard-purged and no upload capability was returned to a client. Match the
-- complete allocation identity so cleanup can never release an unrelated
-- repository's billing fence even if a malformed key is duplicated.
DELETE FROM storage_deletion_queue
WHERE repository_id = sqlc.arg(repository_id)::bigint
  AND allocation_key = sqlc.arg(allocation_key)::text
  AND object_key = sqlc.arg(object_key)::text;


-- name: ReleaseClaimedStorageDeletion :execrows
UPDATE storage_deletion_queue
SET claim_token = NULL,
    claimed_at = NULL,
    attempts = attempts + 1,
    -- Move failures behind other due work. The bounded exponential retry
    -- prevents a full batch of permanent object-store failures from starving
    -- newer tombstones while preserving eventual retry.
    delete_after = NOW() + (
        INTERVAL '1 second' * LEAST(3600, POWER(2, LEAST(attempts, 12)))
    ),
    requested_delete_after = CASE
        WHEN requested_delete_after IS NULL THEN NULL
        ELSE NOW() + (
            INTERVAL '1 second' * LEAST(3600, POWER(2, LEAST(attempts, 12)))
        )
    END,
    last_error = LEFT(sqlc.arg(last_error)::text, 4096),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND claim_token = sqlc.arg(claim_token);


-- name: IsLegacyFinalKeyPurgeAllowed :one
-- Missing/infinite control is fail-closed. The production blob-store wrapper
-- applies this guard to direct service purges as well as queue cleanup.
SELECT COALESCE((
    SELECT isfinite(horizon.valid_until)
           AND horizon.valid_until <= clock_timestamp()
    FROM storage_legacy_capability_horizons AS horizon
    WHERE horizon.capability_kind = 'legacy-final-key-upload'
), FALSE)::boolean;


-- name: GetLegacyFinalKeyCapabilityHorizon :one
SELECT capability_kind, valid_until, attested_at, attested_by, attestation
FROM storage_legacy_capability_horizons
WHERE capability_kind = 'legacy-final-key-upload';


-- name: AttestLegacyFinalKeyCapabilityHorizon :one
-- The table trigger requires a finite future absolute timestamp, operator,
-- and evidence; subsequent calls can only extend the attested horizon.
UPDATE storage_legacy_capability_horizons
SET valid_until = sqlc.arg(valid_until)::timestamptz,
    attested_by = sqlc.arg(attested_by)::text,
    attestation = sqlc.arg(attestation)::text
WHERE capability_kind = 'legacy-final-key-upload'
RETURNING capability_kind, valid_until, attested_at, attested_by, attestation;


-- name: GetStorageDeletionQueueUsageByOwner :one
SELECT COALESCE(SUM(allocation_bytes), 0)::bigint
FROM (
    SELECT MAX(queue.size_bytes) AS allocation_bytes
    FROM storage_deletion_queue AS queue
    LEFT JOIN repositories AS repo ON repo.id = queue.repository_id
    WHERE (
        repo.id IS NOT NULL
        AND (
            (sqlc.arg(owner_type)::text = 'user' AND repo.user_id = sqlc.arg(owner_id)::bigint)
            OR (sqlc.arg(owner_type)::text = 'org' AND repo.org_id = sqlc.arg(owner_id)::bigint)
        )
    ) OR (
        repo.id IS NULL
        AND queue.owner_type = sqlc.arg(owner_type)::text
        AND queue.owner_id = sqlc.arg(owner_id)::bigint
    )
    GROUP BY queue.allocation_key
) AS allocations;


-- name: GetStorageDeletionQueueUsageByRepository :one
SELECT COALESCE(SUM(allocation_bytes), 0)::bigint
FROM (
    SELECT MAX(size_bytes) AS allocation_bytes
    FROM storage_deletion_queue
    WHERE repository_id = sqlc.arg(repository_id)::bigint
    GROUP BY allocation_key
) AS allocations;


-- name: HasStorageDeletionAllocation :one
-- Called under the owner's storage advisory lock immediately before an LFS
-- reservation replaces the same durable allocation. The repository/allocation
-- index keeps this exact re-admission check O(log n).
SELECT EXISTS (
    SELECT 1
    FROM storage_deletion_queue
    WHERE repository_id = sqlc.arg(repository_id)::bigint
      AND allocation_key = sqlc.arg(allocation_key)::text
)::boolean;
