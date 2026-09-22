-- name: SumStorageBytesByOwner :one
-- Every metadata row is authoritative storage or an upload/deletion
-- reservation. Pending rows must count before a signed capability is issued,
-- and retryable deleting rows must remain counted until physical cleanup
-- succeeds; filtering to only ready/finalized rows reopens quota races.
WITH owned_repos AS (
    SELECT id
    FROM repositories
    WHERE (
        sqlc.arg(owner_type)::text = 'user'
        AND user_id = sqlc.arg(owner_id)::bigint
    )
    OR (
        sqlc.arg(owner_type)::text = 'org'
        AND org_id = sqlc.arg(owner_id)::bigint
    )
)
SELECT (
    COALESCE((
        SELECT SUM(lo.size)
        FROM lfs_objects lo
        WHERE lo.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        SELECT SUM(lur.size)
        FROM lfs_upload_reservations lur
        WHERE lur.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        SELECT SUM(wa.size)
        FROM workflow_artifacts wa
        WHERE wa.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        SELECT SUM(wc.object_size_bytes)
        FROM workflow_caches wc
        WHERE wc.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        SELECT SUM(ra.size)
        FROM release_assets ra
        JOIN releases rel ON rel.id = ra.release_id
        WHERE rel.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        SELECT SUM(ia.size)
        FROM issue_artifacts ia
        WHERE ia.repository_id IN (SELECT id FROM owned_repos)
    ), 0)
    + COALESCE((
        -- Queue keys survive repository deletion, so use the live repository's
        -- current owner when present and the denormalized tombstone otherwise.
        -- Final and pending copies share allocation_key and count only once.
        SELECT SUM(queued.allocation_bytes)
        FROM (
            SELECT MAX(sdq.size_bytes) AS allocation_bytes
            FROM storage_deletion_queue sdq
            LEFT JOIN repositories queued_repo ON queued_repo.id = sdq.repository_id
            WHERE (
                queued_repo.id IS NOT NULL
                AND (
                    (sqlc.arg(owner_type)::text = 'user' AND queued_repo.user_id = sqlc.arg(owner_id)::bigint)
                    OR (sqlc.arg(owner_type)::text = 'org' AND queued_repo.org_id = sqlc.arg(owner_id)::bigint)
                )
            ) OR (
                queued_repo.id IS NULL
                AND sdq.owner_type = sqlc.arg(owner_type)::text
                AND sdq.owner_id = sqlc.arg(owner_id)::bigint
            )
            GROUP BY sdq.allocation_key
        ) AS queued
    ), 0)
)::bigint;

-- name: SumStorageBytesByRepository :one
-- Keep this footprint definition in lockstep with SumStorageBytesByOwner.
-- Transfers use it while the repository still belongs to the source owner in
-- the coordinating transaction, then meter the exact footprint against the
-- destination owner's independently locked usage.
SELECT (
    COALESCE((
        SELECT SUM(lo.size)
        FROM lfs_objects lo
        WHERE lo.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(lur.size)
        FROM lfs_upload_reservations lur
        WHERE lur.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(wa.size)
        FROM workflow_artifacts wa
        WHERE wa.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(wc.object_size_bytes)
        FROM workflow_caches wc
        WHERE wc.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(ra.size)
        FROM release_assets ra
        JOIN releases rel ON rel.id = ra.release_id
        WHERE rel.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(ia.size)
        FROM issue_artifacts ia
        WHERE ia.repository_id = sqlc.arg(repository_id)::bigint
    ), 0)
    + COALESCE((
        SELECT SUM(queued.allocation_bytes)
        FROM (
            SELECT MAX(sdq.size_bytes) AS allocation_bytes
            FROM storage_deletion_queue sdq
            WHERE sdq.repository_id = sqlc.arg(repository_id)::bigint
            GROUP BY sdq.allocation_key
        ) AS queued
    ), 0)
)::bigint;

