-- ---- Sandbox instances (control-plane placement rows, read-only from the app) ----

-- name: ListOrphanedSandboxInstances :many
-- Backstop reaper input: live micro-VMs whose owning product row no longer
-- exists, so nothing will ever collect them.
--
-- Both owner tables cascade off repositories(id), so `DELETE /api/repos/{o}/{r}`
-- hard-deletes the repo_gateways / workspaces row and takes the only handle the
-- gateway and workspace reapers have with it — the VM keeps its worker
-- reservation forever. Two such orphans were reclaimed by hand on 2026-08-06.
-- This query finds them by attribution instead: sandbox_instances records the
-- durable owner (resource_kind, resource_id) at Allocate time.
--
-- Guards:
--   * only the two product kinds with a durable owner row are considered;
--     agent_session / workflow_run / anon-sandbox / golden_snapshot_bake VMs
--     have their own lifecycles and are never touched here.
--   * a blank resource_id can never be matched to an owner, so it is skipped
--     rather than treated as orphaned.
--   * owner rows are created before VM allocation and resource_id identifies
--     that row, so a missing owner is conclusive; min_age_seconds remains a
--     query control for operator/tests, while the periodic reaper passes zero.
--   * the comparison is on text, not uuid, so a malformed resource_id cannot
--     abort the sweep with a cast error.
SELECT i.id,
       i.resource_kind,
       i.resource_id,
       i.observed_state,
       i.created_at
FROM sandbox_instances i
WHERE i.deleted_at IS NULL
  AND COALESCE(i.resource_id, '') <> ''
  AND i.resource_kind IN ('repo_gateway', 'workspace')
  AND i.created_at < NOW() - make_interval(secs => sqlc.arg(min_age_seconds)::bigint)
  AND (
    (i.resource_kind = 'repo_gateway'
      AND NOT EXISTS (SELECT 1 FROM repo_gateways g WHERE g.id::text = i.resource_id))
    OR
    (i.resource_kind = 'workspace'
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id::text = i.resource_id))
  )
ORDER BY i.created_at
LIMIT sqlc.arg(max_rows)::int;
