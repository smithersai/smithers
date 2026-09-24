package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func workspaceCovRequest(method, target, body string, params map[string]string, withRepo bool) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	for k, v := range params {
		routeCtx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"}})
	if withRepo {
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
			Owner:      "alice",
			Repository: &db.Repository{ID: 200, Name: "demo", LowerName: "demo"},
		}, middleware.PermissionWrite)
	}
	return req.WithContext(ctx)
}

func workspaceCovWorkspace(id string) services.WorkspaceResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.WorkspaceResponse{
		ID:           id,
		RepositoryID: 200,
		UserID:       42,
		Name:         "dev",
		Status:       "running",
		VMID:         "vm-1",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func workspaceCovSnapshot(id string) services.WorkspaceSnapshotResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.WorkspaceSnapshotResponse{
		ID:           id,
		RepositoryID: 200,
		UserID:       42,
		Name:         "base",
		WorkspaceID:  "ws-1",
		SnapshotID:   "snap-provider-1",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func workspaceCovSession(id string) services.WorkspaceSessionResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.WorkspaceSessionResponse{
		ID:              id,
		WorkspaceID:     "ws-1",
		RepositoryID:    200,
		UserID:          42,
		Status:          "running",
		Cols:            120,
		Rows:            40,
		LastActivityAt:  now,
		IdleTimeoutSecs: 900,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func workspaceCovSSH(sessionID string) services.WorkspaceSSHConnectionInfo {
	return services.WorkspaceSSHConnectionInfo{
		WorkspaceID: "ws-1",
		SessionID:   sessionID,
		VMID:        "vm-1",
		Host:        "ssh.example.test",
		SSHHost:     "ssh.example.test",
		Username:    "smithers",
		Port:        22,
		AccessToken: "token",
		Command:     "ssh smithers@ssh.example.test",
	}
}

func TestWorkspace_Cov_RepositoryScopedRoutes(t *testing.T) {
	params := map[string]string{"id": "ws-1"}
	svc := &mockWorkspaceRouteService{
		listWorkspacesFn: func(_ context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceResponse, int64, error) {
			assert.Equal(t, int64(200), repositoryID)
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, 2, page)
			assert.Equal(t, 2, perPage)
			return []services.WorkspaceResponse{workspaceCovWorkspace("ws-1")}, 3, nil
		},
		resumeWorkspaceFn: func(_ context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
			assert.Equal(t, "ws-1", workspaceID)
			assert.Equal(t, int64(200), repositoryID)
			assert.Equal(t, int64(42), userID)
			ws := workspaceCovWorkspace(workspaceID)
			ws.Status = "running"
			return ws, nil
		},
		forkWorkspaceFn: func(_ context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
			assert.Equal(t, int64(200), input.RepositoryID)
			assert.Equal(t, int64(42), input.UserID)
			assert.Equal(t, "ws-1", input.WorkspaceID)
			assert.Equal(t, "forked", input.Name)
			return workspaceCovWorkspace("ws-fork"), nil
		},
		getWorkspaceSSHFn: func(_ context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			assert.Equal(t, "ws-1", workspaceID)
			return workspaceCovSSH(""), nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	t.Run("list", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces?cursor=2&limit=2", "", params, true)
		rec := httptest.NewRecorder()
		h.ListWorkspaces(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "3", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), "limit=2")
		assert.NotContains(t, rec.Header().Get("Link"), "page=")
		assert.NotContains(t, rec.Header().Get("Link"), "per_page=")
		assert.Contains(t, rec.Body.String(), `"id":"ws-1"`)
	})

	t.Run("resume", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/resume", "", params, true)
		rec := httptest.NewRecorder()
		h.ResumeWorkspace(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"status":"running"`)
	})

	t.Run("fork", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/fork", `{"name":"forked"}`, params, true)
		rec := httptest.NewRecorder()
		h.ForkWorkspace(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), `"id":"ws-fork"`)
	})

	t.Run("workspace ssh", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/ssh", "", params, true)
		rec := httptest.NewRecorder()
		h.GetWorkspaceSSHConnectionInfo(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"access_token":"token"`)
	})
}

func TestWorkspace_Cov_SnapshotsAndSessions(t *testing.T) {
	params := map[string]string{"id": "ws-1"}
	svc := &mockWorkspaceRouteService{
		createWorkspaceSnapshotFn: func(_ context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
			assert.Equal(t, int64(200), input.RepositoryID)
			assert.Equal(t, int64(42), input.UserID)
			assert.Equal(t, "ws-1", input.WorkspaceID)
			assert.Equal(t, "base", input.Name)
			return workspaceCovSnapshot("snap-1"), nil
		},
		getWorkspaceSnapshotFn: func(_ context.Context, snapshotID string, repositoryID, userID int64) (services.WorkspaceSnapshotResponse, error) {
			assert.Equal(t, "snap-1", snapshotID)
			assert.Equal(t, int64(200), repositoryID)
			return workspaceCovSnapshot(snapshotID), nil
		},
		listWorkspaceSnapshotsFn: func(_ context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error) {
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return []services.WorkspaceSnapshotResponse{workspaceCovSnapshot("snap-1")}, 1, nil
		},
		deleteWorkspaceSnapshotFn: func(_ context.Context, snapshotID string, repositoryID, userID int64) error {
			assert.Equal(t, "snap-1", snapshotID)
			return nil
		},
		createSessionFn: func(_ context.Context, input services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
			assert.Equal(t, int64(200), input.RepositoryID)
			assert.Equal(t, int64(42), input.UserID)
			assert.Equal(t, int32(120), input.Cols)
			assert.Equal(t, int32(40), input.Rows)
			assert.Equal(t, "ws-1", input.WorkspaceID)
			return workspaceCovSession("sess-1"), nil
		},
		getSessionFn: func(_ context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			assert.Equal(t, "sess-1", sessionID)
			return workspaceCovSession(sessionID), nil
		},
		listSessionsFn: func(_ context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error) {
			assert.Equal(t, 2, page)
			assert.Equal(t, 1, perPage)
			return []services.WorkspaceSessionResponse{workspaceCovSession("sess-1")}, 2, nil
		},
		getSSHConnectionInfoFn: func(_ context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			assert.Equal(t, "sess-1", sessionID)
			return workspaceCovSSH(sessionID), nil
		},
		destroySessionFn: func(_ context.Context, sessionID string, repositoryID, userID int64) error {
			assert.Equal(t, "sess-1", sessionID)
			return nil
		},
	}
	h := &WorkspaceHandler{Service: svc}

	t.Run("workspace snapshot by route id", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/snapshot", `{"name":"base"}`, params, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspaceSnapshot(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), `"id":"snap-1"`)
	})

	t.Run("snapshot template", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspace-snapshots", `{"workspace_id":"ws-1","name":"base"}`, nil, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspaceSnapshotTemplate(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("get list delete snapshot", func(t *testing.T) {
		snapshotParams := map[string]string{"id": "snap-1"}
		getReq := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspace-snapshots/snap-1", "", snapshotParams, true)
		getRec := httptest.NewRecorder()
		h.GetWorkspaceSnapshot(getRec, getReq)
		require.Equal(t, http.StatusOK, getRec.Code)

		listReq := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspace-snapshots", "", nil, true)
		listRec := httptest.NewRecorder()
		h.ListWorkspaceSnapshots(listRec, listReq)
		require.Equal(t, http.StatusOK, listRec.Code)
		assert.Equal(t, "1", listRec.Header().Get("X-Total-Count"))

		deleteReq := workspaceCovRequest(http.MethodDelete, "/api/repos/alice/demo/workspace-snapshots/snap-1", "", snapshotParams, true)
		deleteRec := httptest.NewRecorder()
		h.DeleteWorkspaceSnapshot(deleteRec, deleteReq)
		require.Equal(t, http.StatusNoContent, deleteRec.Code)
	})

	t.Run("create get list ssh destroy session", func(t *testing.T) {
		createReq := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspace/sessions", `{"workspace_id":"ws-1","cols":120,"rows":40}`, nil, true)
		createRec := httptest.NewRecorder()
		h.CreateSession(createRec, createReq)
		require.Equal(t, http.StatusCreated, createRec.Code)

		sessionParams := map[string]string{"id": "sess-1"}
		getReq := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions/sess-1", "", sessionParams, true)
		getRec := httptest.NewRecorder()
		h.GetSession(getRec, getReq)
		require.Equal(t, http.StatusOK, getRec.Code)

		listReq := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions?cursor=1&limit=1", "", nil, true)
		listRec := httptest.NewRecorder()
		h.ListSessions(listRec, listReq)
		require.Equal(t, http.StatusOK, listRec.Code)
		assert.Equal(t, "2", listRec.Header().Get("X-Total-Count"))

		sshReq := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspace/sessions/sess-1/ssh", "", sessionParams, true)
		sshRec := httptest.NewRecorder()
		h.GetSSHConnectionInfo(sshRec, sshReq)
		require.Equal(t, http.StatusOK, sshRec.Code)
		assert.Contains(t, sshRec.Body.String(), `"session_id":"sess-1"`)

		destroyReq := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspace/sessions/sess-1/destroy", "", sessionParams, true)
		destroyRec := httptest.NewRecorder()
		h.DestroySession(destroyRec, destroyReq)
		require.Equal(t, http.StatusNoContent, destroyRec.Code)
	})
}

func TestWorkspace_Cov_ErrorsUserListingAndHelpers(t *testing.T) {
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		listWorkspacesFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceResponse, int64, error) {
			return nil, 0, apierrors.Internal("list failed")
		},
		listUserWorkspacesFn: func(_ context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error) {
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, 1, page)
			assert.Equal(t, services.MaxUserWorkspacesPerPage, perPage)
			now := time.Now().UTC().Truncate(time.Second)
			return services.UserWorkspaceListResult{
				Items: []services.UserWorkspaceRow{{
					WorkspaceID:     "ws-user",
					RepositoryID:    200,
					RepositoryOwner: "alice",
					RepositoryName:  "demo",
					WorkspaceTitle:  "dev",
					State:           "running",
					CreatedAt:       now,
					SortTimestamp:   now,
				}},
				TotalCount: 1,
			}, nil
		},
	}}

	t.Run("service error", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces", "", nil, true)
		rec := httptest.NewRecorder()
		h.ListWorkspaces(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
		// #267: writeRouteError sanitizes 5xx bodies; "list failed" is logged
		// server-side, not returned to the client.
		assert.Contains(t, rec.Body.String(), "internal server error")
	})

	t.Run("missing repo context", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/repos/alice/demo/workspaces", "", nil, false)
		rec := httptest.NewRecorder()
		h.ListWorkspaces(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository context required")
	})

	t.Run("invalid json", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/fork", "{", map[string]string{"id": "ws-1"}, true)
		rec := httptest.NewRecorder()
		h.ForkWorkspace(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("snapshot template requires workspace id", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodPost, "/api/repos/alice/demo/workspace-snapshots", `{"name":"base"}`, nil, true)
		rec := httptest.NewRecorder()
		h.CreateWorkspaceSnapshotTemplate(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "workspace_id is required")
	})

	t.Run("user workspaces cap", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/user/workspaces?limit=999", "", nil, false)
		rec := httptest.NewRecorder()
		h.GetUserWorkspaces(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var rows []services.UserWorkspaceRow
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		require.Len(t, rows, 1)
		assert.Equal(t, "ws-user", rows[0].WorkspaceID)
	})

	t.Run("user workspaces invalid limit", func(t *testing.T) {
		req := workspaceCovRequest(http.MethodGet, "/api/user/workspaces?limit=0", "", nil, false)
		rec := httptest.NewRecorder()
		h.GetUserWorkspaces(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("event id extraction", func(t *testing.T) {
		assert.Equal(t, "9", extractWorkspaceEventID(`{"id":9}`))
		assert.Equal(t, "12", extractWorkspaceEventID(`{"sequence":12}`))
		assert.Empty(t, extractWorkspaceEventID(`{"id":0}`))
		assert.Empty(t, extractWorkspaceEventID(`{`))
	})
}
