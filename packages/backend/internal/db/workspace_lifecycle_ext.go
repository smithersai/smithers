package db

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Hand-written compare-and-swap transitions for workspace sessions. The
// workspace transitions live in db/product/queries/workspace.sql. Unconditional
// `WHERE id = $1` updates let stale detached-provisioning goroutines resurrect
// terminal rows and let concurrent suspend/resume callers double-count the
// active-VM gauge (issues #313, #312, #115, #296).

// workspaceSessionExtReturningColumns must name every workspace_sessions
// column the WorkspaceSession model carries: the CAS results below become the
// synchronous create response, so a column missing here (kind and language
// were, plue #505) reaches the client as its zero value.
const workspaceSessionExtReturningColumns = `id, workspace_id, repository_id, user_id, ssh_connection_info, status, cols, rows, last_activity_at, idle_timeout_secs, created_at, updated_at, kind, language`

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
