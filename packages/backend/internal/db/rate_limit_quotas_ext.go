package db

import "context"

func (q *Queries) CountConnectedReposForUser(ctx context.Context, userID int64) (int, error) {
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*)
FROM repo_connections
WHERE user_id = $1
`, userID).Scan(&count)
	return count, err
}

func (q *Queries) CountActiveWorkflowRunsForUser(ctx context.Context, userID int64) (int, error) {
	// The per-user concurrent-run cap gates workflow dispatch on EVERY repo the
	// user can dispatch to, so the footprint must cover org-member and
	// collaborator repos too — counting only personally-owned repos made the
	// cap a no-op for org/collaborator dispatches (a user could stack unbounded
	// concurrent runs on an org repo while their personal count stayed 0).
	// workflow_runs has no dispatching-user attribution column, so this counts
	// active runs across the user's whole dispatchable surface; on busy shared
	// repos that errs conservative (a teammate's runs count against you), which
	// is the right failure mode for a runner-capacity safety cap.
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*)
FROM workflow_runs wr
JOIN repositories r ON r.id = wr.repository_id
WHERE wr.status IN ('queued', 'running')
  AND (
    r.user_id = $1
    OR r.org_id IN (SELECT organization_id FROM org_members WHERE user_id = $1)
    OR r.id IN (SELECT repository_id FROM collaborators WHERE user_id = $1)
  )
`, userID).Scan(&count)
	return count, err
}

func (q *Queries) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	// A user's concurrent-sandbox footprint spans BOTH workspace VMs and the
	// durable per-repo gateway VMs — each consumes a real Microsandbox micro-VM, so
	// gateways must count toward the same per-user cap (otherwise gateway VMs are
	// entirely uncapped). Gateway rows count while a VM consumes COMPUTE
	// (starting/running with vm_id <> '') — the same statuses workspaces count —
	// plus 'pending' rows, which are durable provision reservations inserted
	// BEFORE the cap check so two racing provisions see each other instead of
	// both passing a stale count (a crashed pending row is reaped within the
	// gateway stale-provision age). Suspended VMs hold only disk, and counting
	// suspended gateways while excluding suspended workspaces silently ate the
	// cap (2026-07-08: idle gateways starved terminal provisioning).
	// Failed/stopped/soft-deleted rows have no live VM and hold no reservation.
	var count int
	err := q.db.QueryRow(ctx, `
SELECT
  (
    SELECT COUNT(*)
    FROM workspaces
    WHERE user_id = $1
      AND deleted_at IS NULL
      AND status IN ('pending', 'starting', 'running')
  )
  +
  (
    SELECT COUNT(*)
    FROM repo_gateways
    WHERE user_id = $1
      AND deleted_at IS NULL
      AND workspace_id IS NULL
      AND (
        (vm_id <> '' AND status IN ('starting', 'running'))
        OR status = 'pending'
      )
  )
`, userID).Scan(&count)
	return count, err
}
