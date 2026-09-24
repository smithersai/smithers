package db

import "context"

// CountActiveAgentSessionVMs returns the number of agent sessions that currently
// hold a live Microsandbox VM across the WHOLE fleet.
//
// This is a hand-written extension method (not sqlc-generated) following the
// rate_limit_quotas_ext.go pattern rather than db/product/queries.
//
// The predicate matches the reaper's live-VM definition (ListStaleActiveSessions
// in db/product/queries/agent.sql): a session is counted only while status='active' AND
// it has been dispatched (started_at IS NOT NULL, stamped by
// ReserveAgentSessionVMSlot just before VM provisioning begins so provisioning
// sessions count toward the cap) AND it is not tombstoned (deleted_at IS NULL).
// Bare status='active' would
// over-count freshly-created, never-dispatched sessions that hold no VM yet, and
// terminal (completed/failed/cancelled/timed_out) sessions have already had their
// VM deleted.
//
// It is intentionally GLOBAL (no user_id filter): the cap it backs is a
// fleet-wide Microsandbox-spend guard against a runaway agent loop, not a per-user
// quota.
func (q *Queries) CountActiveAgentSessionVMs(ctx context.Context) (int, error) {
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*)
FROM agent_sessions
WHERE status = 'active'
  AND started_at IS NOT NULL
  AND deleted_at IS NULL
`).Scan(&count)
	return count, err
}
