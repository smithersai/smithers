-- Private cluster queries kept separate from the product graph.

-- name: AdminListSandboxHosts :many
SELECT sqlc.embed(h), (SELECT count(*) FROM sandbox_instances i WHERE i.worker_id = h.id AND i.deleted_at IS NULL)::bigint AS instance_count
FROM sandbox_hosts h ORDER BY h.id;


-- name: AdminPruneStaleSandboxHosts :one
-- The deletion and its exact affected targets commit with the audit, or neither
-- commits. A retry cannot erase the original target list from the audit trail.
WITH pruned AS (
    DELETE FROM sandbox_hosts h
    WHERE h.lease_expires_at < now() - make_interval(hours => sqlc.arg(older_than_hours)::int)
    AND NOT EXISTS (SELECT 1 FROM sandbox_instances i WHERE i.worker_id = h.id AND i.deleted_at IS NULL)
    RETURNING h.id
), audited AS (
    INSERT INTO audit_log (event_type, actor_id, actor_name, target_type, target_name, action, metadata, ip_address)
    SELECT 'admin.sandbox_host.prune', sqlc.narg(actor_id)::bigint, sqlc.arg(actor_name)::text,
           'sandbox_host', '', 'prune',
           jsonb_build_object('outcome', 'succeeded', 'older_than_hours', sqlc.arg(older_than_hours)::int,
                              'pruned', count(*), 'host_ids', COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)),
           sqlc.arg(ip_address)::text
    FROM pruned
    RETURNING id
)
SELECT count(*)::bigint AS pruned FROM pruned WHERE EXISTS (SELECT 1 FROM audited);

