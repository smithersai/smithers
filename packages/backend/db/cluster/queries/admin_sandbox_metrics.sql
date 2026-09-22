-- Private cluster queries kept separate from the product graph.

-- name: GetSandboxActiveVMsByKind :many
-- Retain zero series for known kinds after their last reservation is released.
SELECT COALESCE(resource_kind, 'unknown')::text AS kind,
       COUNT(*) FILTER (WHERE reservation_held AND deleted_at IS NULL)::bigint AS count
FROM sandbox_instances
GROUP BY COALESCE(resource_kind, 'unknown');


-- name: GetSandboxInstancesByState :many
SELECT states.observed_state::text AS observed_state, COUNT(si.id)::bigint AS count
FROM (VALUES ('created'), ('starting'), ('running'), ('stopping'), ('stopped'),
             ('restart_pending'), ('recovering'), ('deleting'), ('degraded'),
             ('failed'), ('deleted')) AS states(observed_state)
LEFT JOIN sandbox_instances si ON si.observed_state = states.observed_state AND si.deleted_at IS NULL
GROUP BY states.observed_state;
