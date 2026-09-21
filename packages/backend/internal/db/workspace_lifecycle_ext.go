package db

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Hand-written extension methods (not sqlc-generated) following the
// agent_session_concurrency_ext.go pattern, so they do NOT require
// `zig build sqlc`. They add compare-and-swap state transitions for the
// workspace/session lifecycle: unconditional `WHERE id = $1` updates let stale
// detached-provisioning goroutines resurrect terminal rows and let concurrent
// suspend/resume callers double-count the active-VM gauge (issues #313, #312,
// #115, #296).

const workspaceExtReturningColumns = `id, repository_id, user_id, name, is_fork, parent_workspace_id, target_bookmark, source_snapshot_id, vm_id, status, last_activity_at, idle_timeout_secs, suspended_at, last_accessed_at, deleted_at, created_at, updated_at`

// workspaceSessionExtReturningColumns must name every workspace_sessions
// column the WorkspaceSession model carries: the CAS results below become the
// synchronous create response, so a column missing here (kind and language
// were, plue #505) reaches the client as its zero value.
const workspaceSessionExtReturningColumns = `id, workspace_id, repository_id, user_id, ssh_connection_info, status, cols, rows, last_activity_at, idle_timeout_secs, created_at, updated_at, kind, language`

func scanWorkspaceExtRow(row pgx.Row) (Workspace, error) {
	var i Workspace
	err := row.Scan(
		&i.ID,
		&i.RepositoryID,
		&i.UserID,
		&i.Name,
		&i.IsFork,
		&i.ParentWorkspaceID,
		&i.TargetBookmark,
		&i.SourceSnapshotID,
		&i.VmID,
		&i.Status,
		&i.LastActivityAt,
		&i.IdleTimeoutSecs,
		&i.SuspendedAt,
		&i.LastAccessedAt,
		&i.DeletedAt,
		&i.CreatedAt,
		&i.UpdatedAt,
	)
	return i, err
}

func scanWorkspaceSessionExtRow(row pgx.Row) (WorkspaceSession, error) {
	var i WorkspaceSession
	err := row.Scan(
		&i.ID,
		&i.WorkspaceID,
		&i.RepositoryID,
		&i.UserID,
		&i.SshConnectionInfo,
		&i.Status,
		&i.Cols,
		&i.Rows,
		&i.LastActivityAt,
		&i.IdleTimeoutSecs,
		&i.CreatedAt,
		&i.UpdatedAt,
		&i.Kind,
		&i.Language,
	)
	return i, err
}

// MarkWorkspaceSessionRunning CASes a session from an in-flight provisioning
// state (pending/starting) to running. A session the user already stopped (or
// that failed) matches no rows, so a stale detached provisioning goroutine gets
// pgx.ErrNoRows instead of resurrecting a terminal session.
func (q *Queries) MarkWorkspaceSessionRunning(ctx context.Context, id string) (WorkspaceSession, error) {
	return scanWorkspaceSessionExtRow(q.db.QueryRow(ctx, `
UPDATE workspace_sessions
SET status = 'running', updated_at = NOW()
WHERE id = $1
  AND status IN ('pending', 'starting')
RETURNING `+workspaceSessionExtReturningColumns, id))
}

// FailActiveWorkspaceSession CASes a session from any non-terminal state to
// failed. A session already stopped by the user (or already failed) matches no
// rows, so provisioning-failure cleanup cannot relabel a user stop as a failure.
func (q *Queries) FailActiveWorkspaceSession(ctx context.Context, id string) (WorkspaceSession, error) {
	return scanWorkspaceSessionExtRow(q.db.QueryRow(ctx, `
UPDATE workspace_sessions
SET status = 'failed', updated_at = NOW()
WHERE id = $1
  AND status IN ('pending', 'starting', 'running')
RETURNING `+workspaceSessionExtReturningColumns, id))
}

// SuspendRunningWorkspaceIfSessionless CASes a workspace from running to
// suspended, but only while it has no active (pending/starting/running)
// sessions or a live bound repository gateway. A native repository run needs
// no terminal session, so it uses the same gateway fence as idle cleanup.
// The NOT EXISTS gates are evaluated in the same statement as the
// status flip, so a session created concurrently with a last-session destroy
// can never be stranded on a workspace this call just decided to suspend.
func (q *Queries) SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (Workspace, error) {
	return scanWorkspaceExtRow(q.db.QueryRow(ctx, `
UPDATE workspaces w
SET status = 'suspended',
    suspended_at = NOW(),
    updated_at = NOW()
WHERE w.id = $1
  AND w.status = 'running'
  AND w.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_sessions s
      WHERE s.workspace_id = w.id
        AND s.status IN ('pending', 'starting', 'running')
  )
  AND NOT EXISTS (
      SELECT 1
      FROM repo_gateways g
      WHERE g.workspace_id = w.id AND g.vm_id = w.vm_id
        AND g.deleted_at IS NULL AND g.status IN ('starting', 'running')
  )
RETURNING `+workspaceExtReturningColumns, id))
}

// ResumeWorkspaceToRunning CASes a workspace into running from any non-running,
// non-deleted state. Exactly one of N concurrent resumes wins the transition
// (the rest get pgx.ErrNoRows), so the caller can pair the active-VM gauge +1
// one-to-one with the row entering 'running'.
func (q *Queries) ResumeWorkspaceToRunning(ctx context.Context, id string) (Workspace, error) {
	return scanWorkspaceExtRow(q.db.QueryRow(ctx, `
UPDATE workspaces
SET status = 'running',
    suspended_at = NULL,
    updated_at = NOW()
WHERE id = $1
  AND status <> 'running'
  AND deleted_at IS NULL
RETURNING `+workspaceExtReturningColumns, id))
}

// ListStaleStartingWorkspacesWithVM finds workspaces stranded in 'starting'
// WITH a registered VM past the stale threshold — the rows a mid-provision API
// crash leaves behind. ListStalePendingWorkspaces deliberately requires
// vm_id = ” (a live provision holds 'starting' with a VM for minutes), so
// these rows were previously invisible to every reaper while still counting
// toward the per-user active-workspace quota.
func (q *Queries) ListStaleStartingWorkspacesWithVM(ctx context.Context, staleAfterSecs int32) ([]Workspace, error) {
	rows, err := q.db.Query(ctx, `
SELECT `+workspaceExtReturningColumns+`
FROM workspaces
WHERE status = 'starting'
  AND vm_id <> ''
  AND deleted_at IS NULL
  AND updated_at < NOW() - make_interval(secs => $1::int)
ORDER BY updated_at ASC`, staleAfterSecs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Workspace
	for rows.Next() {
		item, err := scanWorkspaceExtRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// FailStaleStartingWorkspaceParams parameterizes FailStaleStartingWorkspace.
type FailStaleStartingWorkspaceParams struct {
	ID             string `json:"id"`
	StaleAfterSecs int32  `json:"stale_after_secs"`
}

// FailStaleStartingWorkspace CASes a stranded 'starting' workspace to 'failed',
// re-checking the staleness predicate in the same statement so a provision that
// completed (or a user attach that marked the row running) between the reaper's
// list and this update matches no rows and is left untouched.
func (q *Queries) FailStaleStartingWorkspace(ctx context.Context, arg FailStaleStartingWorkspaceParams) (Workspace, error) {
	return scanWorkspaceExtRow(q.db.QueryRow(ctx, `
UPDATE workspaces
SET status = 'failed',
    updated_at = NOW()
WHERE id = $1
  AND status = 'starting'
  AND deleted_at IS NULL
  AND updated_at < NOW() - make_interval(secs => $2::int)
RETURNING `+workspaceExtReturningColumns, arg.ID, arg.StaleAfterSecs))
}
