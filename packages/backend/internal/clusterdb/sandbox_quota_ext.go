package clusterdb

import "context"

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
