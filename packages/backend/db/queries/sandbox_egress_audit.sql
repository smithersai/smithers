-- name: InsertSandboxEgressAuditBatch :execrows
WITH batch AS (
    SELECT
        item ->> 'sandbox_id' AS sandbox_id,
        (item ->> 'occurred_at')::timestamptz AS occurred_at,
        item ->> 'host' AS host,
        item ->> 'method' AS method,
        item ->> 'path' AS path,
        (item ->> 'status')::integer AS status,
        (item ->> 'allowed')::boolean AS allowed,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(item -> 'swapped_secret_names', '[]'::jsonb))) AS swapped_secret_names,
        COALESCE(item -> 'transform_summary', '{}'::jsonb) AS transform_summary
    FROM jsonb_array_elements(sqlc.arg(records)::jsonb) AS item
)
INSERT INTO sandbox_egress_audit (
    sandbox_id,
    resource_kind,
    resource_id,
    repository_id,
    occurred_at,
    host,
    method,
    path,
    status,
    allowed,
    swapped_secret_names,
    transform_summary
)
SELECT
    batch.sandbox_id,
    instance.resource_kind,
    instance.resource_id,
    CASE instance.resource_kind
        WHEN 'agent_session' THEN (
            SELECT session.repository_id
            FROM agent_sessions AS session
            WHERE session.id = instance.resource_id::uuid
        )
        WHEN 'workspace' THEN (
            SELECT workspace.repository_id
            FROM workspaces AS workspace
            WHERE workspace.id = instance.resource_id::uuid
        )
        ELSE NULL
    END,
    batch.occurred_at,
    batch.host,
    batch.method,
    batch.path,
    batch.status,
    batch.allowed,
    COALESCE(batch.swapped_secret_names, '{}'::text[]),
    COALESCE(batch.transform_summary, '{}'::jsonb)
FROM batch
JOIN sandbox_instances AS instance
  ON instance.id = batch.sandbox_id
 AND instance.worker_id = sqlc.arg(worker_id)::text
WHERE instance.resource_kind IS NOT NULL
  AND instance.resource_id IS NOT NULL;

-- name: ListSandboxEgressAuditByResource :many
SELECT *
FROM sandbox_egress_audit
WHERE resource_kind = sqlc.arg(resource_kind)
  AND resource_id = sqlc.arg(resource_id)
  AND repository_id = sqlc.arg(repository_id)
  AND (
      NOT sqlc.arg(has_cursor)::boolean
      OR (occurred_at, id) < (sqlc.arg(cursor_occurred_at)::timestamptz, sqlc.arg(cursor_id)::bigint)
  )
ORDER BY occurred_at DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: DeleteSandboxEgressAuditOlderThan :execrows
DELETE FROM sandbox_egress_audit
WHERE occurred_at < NOW() - (sqlc.arg(retention_days)::bigint * INTERVAL '1 day');
