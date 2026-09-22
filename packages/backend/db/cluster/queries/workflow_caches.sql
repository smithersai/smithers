-- Private cluster queries kept separate from the product graph.

-- name: GetWorkflowCacheRepoUsage :one
-- Retained deletion-queue allocations still occupy cache quota after their
-- active metadata row is gone. Final/pending exact keys share allocation_key
-- and therefore count only once here, matching global repository billing.
SELECT (
    COALESCE((
        SELECT SUM(wc.object_size_bytes)
        FROM workflow_caches AS wc
        WHERE wc.repository_id = sqlc.arg(target_repository_id)
          AND wc.status IN ('pending', 'finalized', 'deleting')
    ), 0)
    + COALESCE((
        SELECT SUM(allocation_bytes)
        FROM (
            SELECT MAX(sdq.size_bytes) AS allocation_bytes
            FROM storage_deletion_queue AS sdq
            WHERE sdq.repository_id = sqlc.arg(target_repository_id)
              AND sdq.allocation_key LIKE 'workflow-cache:%'
            GROUP BY sdq.allocation_key
        ) AS queued_cache_allocations
    ), 0)
)::bigint;

