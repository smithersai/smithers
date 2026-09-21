package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func workspaceExecHSession(id, workspaceID string, userID int64, status string) db.WorkspaceSession {
	return db.WorkspaceSession{
		ID:           id,
		WorkspaceID:  workspaceID,
		RepositoryID: 101,
		UserID:       userID,
		Status:       status,
		Cols:         100,
		Rows:         40,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
}

func TestWorkspaceExec_H_GetAndListSessionBranches(t *testing.T) {
	ctx := context.Background()
	_, err := NewWorkspaceService(nil).GetSession(ctx, "sess", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
	})
	_, err = svc.GetSession(ctx, "missing", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	_, _, err = NewWorkspaceService(nil).ListSessions(ctx, 101, 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	var listArg db.ListWorkspaceSessionsByRepoParams
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspaceSessionsByRepoFn: func(_ context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
			listArg = arg
			return []db.WorkspaceSession{workspaceExecHSession("sess-1", "ws-1", 1, "running")}, nil
		},
		countWorkspaceSessionsByRepoFn: func(context.Context, db.CountWorkspaceSessionsByRepoParams) (int64, error) {
			return 1, nil
		},
	})
	sessions, total, err := svc.ListSessions(ctx, 101, 1, -1, 500)
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.Equal(t, int64(1), total)
	assert.Equal(t, int32(0), listArg.PageOffset)
	assert.Equal(t, int32(30), listArg.PageSize)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspaceSessionsByRepoFn: func(context.Context, db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
			return nil, errors.New("list failed")
		},
	})
	_, _, err = svc.ListSessions(ctx, 101, 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listWorkspaceSessionsByRepoFn: func(context.Context, db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
			return nil, nil
		},
		countWorkspaceSessionsByRepoFn: func(context.Context, db.CountWorkspaceSessionsByRepoParams) (int64, error) {
			return 0, errors.New("count failed")
		},
	})
	_, _, err = svc.ListSessions(ctx, 101, 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWorkspaceExec_H_DestroySessionBranches(t *testing.T) {
	ctx := context.Background()
	err := NewWorkspaceService(nil).DestroySession(ctx, "sess", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("load failed")
		},
	})
	err = svc.DestroySession(ctx, "sess", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return workspaceExecHSession("sess", "ws-1", 1, "running"), nil
		},
		updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("update failed")
		},
	})
	err = svc.DestroySession(ctx, "sess", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	var updated bool
	var notified string
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return workspaceExecHSession("sess", "ws-1", 1, "stopped"), nil
		},
		updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			updated = true
			return db.WorkspaceSession{}, nil
		},
		countActiveSessionsForWorkspaceFn: func(context.Context, string) (int64, error) {
			return 1, errors.New("count ignored")
		},
		notifyWorkspaceStatusFn: func(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
			notified = arg.SessionID
			return nil
		},
	})
	require.NoError(t, svc.DestroySession(ctx, "sess", 101, 1))
	assert.False(t, updated)
	assert.Equal(t, "sess", notified)

	// A session whose owning workspace is gone is not operable: session access
	// is authorized against the owning workspace, so the loader collapses the
	// missing workspace into a uniform 404 before any destroy side effects.
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return workspaceExecHSession("sess", "ws-missing", 1, "running"), nil
		},
		countActiveSessionsForWorkspaceFn: func(context.Context, string) (int64, error) {
			return 0, nil
		},
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	})
	err = svc.DestroySession(ctx, "sess", 101, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))
}

func TestWorkspaceExec_H_NotifyWorkspaceSanitizesAndSkips(t *testing.T) {
	var calls []db.NotifyWorkspaceStatusParams
	q := &mockWorkspaceQuerier{
		notifyWorkspaceStatusFn: func(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
			calls = append(calls, arg)
			return errors.New("ignored")
		},
	}
	svc := newWorkspaceServiceForTests(q)
	svc.notifyWorkspaceSession(context.Background(), "", "running")
	svc.notifyWorkspace(context.Background(), "ws-1-2", "running")
	require.Len(t, calls, 1)
	assert.Equal(t, "ws12", calls[0].SessionID)

	(&WorkspaceService{}).notifyWorkspaceSession(context.Background(), "sess", "failed")
	(&WorkspaceService{}).notifyWorkspace(context.Background(), "ws", "failed")
}
