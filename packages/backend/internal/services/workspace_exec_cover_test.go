package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWorkspaceExec_Cov_ListDestroyAndNotifyBranches(t *testing.T) {
	t.Run("list sessions defaults pagination and maps count errors", func(t *testing.T) {
		var listArg db.ListWorkspaceSessionsByRepoParams
		q := &mockWorkspaceQuerier{
			listWorkspaceSessionsByRepoFn: func(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error) {
				listArg = arg
				return []db.WorkspaceSession{{ID: "sess-1", WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: arg.UserID, Status: "running"}}, nil
			},
			countWorkspaceSessionsByRepoFn: func(context.Context, db.CountWorkspaceSessionsByRepoParams) (int64, error) {
				return 0, assert.AnError
			},
		}
		svc := newWorkspaceServiceForTests(q)

		_, _, err := svc.ListSessions(context.Background(), 101, 7, -10, 500)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 500, apiErr.Status)
		assert.Equal(t, int32(0), listArg.PageOffset)
		assert.Equal(t, int32(30), listArg.PageSize)
	})

	t.Run("destroy stopped session still notifies and skips status update", func(t *testing.T) {
		var notifications []db.NotifyWorkspaceStatusParams
		updateCalled := false
		q := &mockWorkspaceQuerier{
			getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
				return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: 7, Status: "stopped"}, nil
			},
			getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
				ws := sampleDBWorkspace(arg.ID)
				ws.UserID = 7 // session authz resolves against the workspace owner
				return ws, nil
			},
			updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
				updateCalled = true
				return db.WorkspaceSession{}, nil
			},
			countActiveSessionsForWorkspaceFn: func(context.Context, string) (int64, error) {
				return 1, nil
			},
			notifyWorkspaceStatusFn: func(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error {
				notifications = append(notifications, arg)
				return nil
			},
		}
		svc := newWorkspaceServiceForTests(q)

		require.NoError(t, svc.DestroySession(context.Background(), "sess-1", 101, 7))
		assert.False(t, updateCalled)
		require.Len(t, notifications, 1)
		assert.Equal(t, "sess1", notifications[0].SessionID)
		assert.JSONEq(t, `{"status":"stopped"}`, notifications[0].Payload)
	})

	t.Run("notify workspace uses sanitized id", func(t *testing.T) {
		var payload db.NotifyWorkspaceStatusParams
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
			notifyWorkspaceStatusFn: func(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error {
				payload = arg
				return nil
			},
		})
		svc.notifyWorkspace(context.Background(), "ws-123-abc", "running")

		assert.Equal(t, "ws123abc", payload.SessionID)
		var decoded map[string]string
		require.NoError(t, json.Unmarshal([]byte(payload.Payload), &decoded))
		assert.Equal(t, "running", decoded["status"])

		svc.notifyWorkspace(context.Background(), "ws-123-abc", "failed", workspaceFailureDetails{
			Code: "quiesce_failed", Message: "sandbox could not quiesce",
		})
		require.NoError(t, json.Unmarshal([]byte(payload.Payload), &decoded))
		assert.Equal(t, "failed", decoded["status"])
		assert.Equal(t, "quiesce_failed", decoded["failure_code"])
		assert.Equal(t, "sandbox could not quiesce", decoded["failure_message"])
	})
}

func TestWorkspaceExec_Cov_DestroySessionUpdateFailure(t *testing.T) {
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: 7, Status: "running"}, nil
		},
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.UserID = 7 // session authz resolves against the workspace owner
			return ws, nil
		},
		updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, assert.AnError
		},
	}
	svc := newWorkspaceServiceForTests(q)

	err := svc.DestroySession(context.Background(), "sess-fail", 101, 7)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "update workspace session status")
}
