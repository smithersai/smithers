-- name: InsertAuditLog :exec
INSERT INTO audit_log (event_type, actor_id, actor_name, target_type, target_id, target_name, action, metadata, ip_address)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: ListAuditLogs :many
SELECT * FROM audit_log
WHERE created_at >= @since
ORDER BY created_at DESC
LIMIT @page_limit OFFSET @page_offset;

-- name: ListAuditLogsByActor :many
SELECT * FROM audit_log
WHERE actor_id = $1 AND created_at >= @since
ORDER BY created_at DESC
LIMIT @page_limit OFFSET @page_offset;

-- name: ListPublicAuditLogsByActor :many
SELECT al.*
FROM audit_log al
JOIN repositories r ON r.id = al.target_id
WHERE al.actor_id = $1
  AND al.created_at >= @since
  AND al.target_type = 'repository'
  AND al.event_type LIKE 'repo.%'
  AND r.is_public = TRUE
ORDER BY al.created_at DESC
LIMIT @page_limit OFFSET @page_offset;

-- name: CountPublicAuditLogsByActor :one
SELECT COUNT(*)
FROM audit_log al
JOIN repositories r ON r.id = al.target_id
WHERE al.actor_id = $1
  AND al.created_at >= @since
  AND al.target_type = 'repository'
  AND al.event_type LIKE 'repo.%'
  AND r.is_public = TRUE;

-- name: DeleteAuditLogsOlderThan :exec
DELETE FROM audit_log WHERE created_at < $1;

-- name: ListAuditLogsFiltered :many
-- Filtered audit-log listing. Filters are optional: pass empty strings for
-- text filters (event_type/target_type/target_name) and 0 for the numeric
-- actor_id to disable them. Ticket 0134 added this so operators can ask
-- "show me the audit trail for approval X" without paging through
-- unrelated rows.
--
-- target_name is used (not target_id) for approval filters because
-- audit_log.target_id is a BIGINT, while approvals.id is a UUID; we store
-- the approval UUID in target_name and index on (target_type, target_id).
SELECT * FROM audit_log
WHERE created_at >= @since
  AND (@event_type::text = '' OR event_type = @event_type)
  AND (@target_type::text = '' OR target_type = @target_type)
  AND (@target_name::text = '' OR target_name = @target_name)
  AND (@actor_id::bigint = 0 OR actor_id = @actor_id)
ORDER BY created_at DESC
LIMIT @page_limit OFFSET @page_offset;
