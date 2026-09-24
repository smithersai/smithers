package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func workspaceHRequest(method, target, body string, params map[string]string, authed, withRepo bool) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if len(params) > 0 {
		req = withRouteParams(req, params)
	}
	if withRepo {
		req = withWorkspaceRepoCtx(req, "alice", "demo")
	}
	if authed {
		req = withAuth(req, 42, "alice")
	}
	return req
}

func workspaceHErrorService() *mockWorkspaceRouteService {
	err := apierrors.NotFound("missing")
	return &mockWorkspaceRouteService{
		getWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, err
		},
		listWorkspacesFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceResponse, int64, error) {
			return nil, 0, err
		},
		getWorkspaceSSHFn: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{}, err
		},
		suspendWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, err
		},
		resumeWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, err
		},
		deleteWorkspaceFn: func(context.Context, string, int64, int64) error {
			return err
		},
		forkWorkspaceFn: func(context.Context, services.ForkWorkspaceInput) (services.WorkspaceResponse, error) {
			return services.WorkspaceResponse{}, err
		},
		createWorkspaceSnapshotFn: func(context.Context, services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error) {
			return services.WorkspaceSnapshotResponse{}, err
		},
		getWorkspaceSnapshotFn: func(context.Context, string, int64, int64) (services.WorkspaceSnapshotResponse, error) {
			return services.WorkspaceSnapshotResponse{}, err
		},
		listWorkspaceSnapshotsFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceSnapshotResponse, int64, error) {
			return nil, 0, err
		},
		deleteWorkspaceSnapshotFn: func(context.Context, string, int64, int64) error {
			return err
		},
		createSessionFn: func(context.Context, services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{}, err
		},
		getSessionFn: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{}, err
		},
		listSessionsFn: func(context.Context, int64, int64, int, int) ([]services.WorkspaceSessionResponse, int64, error) {
			return nil, 0, err
		},
		getSSHConnectionInfoFn: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{}, err
		},
		destroySessionFn: func(context.Context, string, int64, int64) error {
			return err
		},
		listUserWorkspacesFn: func(context.Context, int64, int, int) (services.UserWorkspaceListResult, error) {
			return services.UserWorkspaceListResult{}, err
		},
	}
}

func TestWorkspace_H_CreateWorkspaceInvalidBody(t *testing.T) {
	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	req := workspaceHRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", "{", nil, true, true)
	rec := httptest.NewRecorder()

	h.CreateWorkspace(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkspace_H_HandlerErrorBranches(t *testing.T) {
	defaultService := &mockWorkspaceRouteService{}
	errorService := workspaceHErrorService()
	validID := map[string]string{"id": "ws-1"}
	missingID := map[string]string{"id": " "}

	tests := []struct {
		name       string
		handler    func(*WorkspaceHandler, http.ResponseWriter, *http.Request)
		method     string
		target     string
		body       string
		params     map[string]string
		authed     bool
		withRepo   bool
		service    *mockWorkspaceRouteService
		wantStatus int
	}{
		{"get workspace no auth", (*WorkspaceHandler).GetWorkspace, http.MethodGet, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"get workspace no repo", (*WorkspaceHandler).GetWorkspace, http.MethodGet, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"get workspace missing id", (*WorkspaceHandler).GetWorkspace, http.MethodGet, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"list workspaces no auth", (*WorkspaceHandler).ListWorkspaces, http.MethodGet, "/x", "", nil, false, true, defaultService, http.StatusUnauthorized},
		{"list workspaces invalid pagination", (*WorkspaceHandler).ListWorkspaces, http.MethodGet, "/x?limit=bad", "", nil, true, true, defaultService, http.StatusBadRequest},
		{"workspace ssh no auth", (*WorkspaceHandler).GetWorkspaceSSHConnectionInfo, http.MethodGet, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"workspace ssh no repo", (*WorkspaceHandler).GetWorkspaceSSHConnectionInfo, http.MethodGet, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"workspace ssh missing id", (*WorkspaceHandler).GetWorkspaceSSHConnectionInfo, http.MethodGet, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"workspace ssh service error", (*WorkspaceHandler).GetWorkspaceSSHConnectionInfo, http.MethodGet, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"suspend no auth", (*WorkspaceHandler).SuspendWorkspace, http.MethodPost, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"suspend no repo", (*WorkspaceHandler).SuspendWorkspace, http.MethodPost, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"suspend missing id", (*WorkspaceHandler).SuspendWorkspace, http.MethodPost, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"suspend service error", (*WorkspaceHandler).SuspendWorkspace, http.MethodPost, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"resume no auth", (*WorkspaceHandler).ResumeWorkspace, http.MethodPost, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"resume no repo", (*WorkspaceHandler).ResumeWorkspace, http.MethodPost, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"resume missing id", (*WorkspaceHandler).ResumeWorkspace, http.MethodPost, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"resume service error", (*WorkspaceHandler).ResumeWorkspace, http.MethodPost, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"delete workspace no auth", (*WorkspaceHandler).DeleteWorkspace, http.MethodDelete, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"delete workspace no repo", (*WorkspaceHandler).DeleteWorkspace, http.MethodDelete, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"delete workspace missing id", (*WorkspaceHandler).DeleteWorkspace, http.MethodDelete, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"fork no auth", (*WorkspaceHandler).ForkWorkspace, http.MethodPost, "/x", `{"name":"fork"}`, validID, false, true, defaultService, http.StatusUnauthorized},
		{"fork no repo", (*WorkspaceHandler).ForkWorkspace, http.MethodPost, "/x", `{"name":"fork"}`, validID, true, false, defaultService, http.StatusBadRequest},
		{"fork missing id", (*WorkspaceHandler).ForkWorkspace, http.MethodPost, "/x", `{"name":"fork"}`, missingID, true, true, defaultService, http.StatusBadRequest},
		{"snapshot no auth", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, "/x", `{"name":"snap"}`, validID, false, true, defaultService, http.StatusUnauthorized},
		{"snapshot no repo", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, "/x", `{"name":"snap"}`, validID, true, false, defaultService, http.StatusBadRequest},
		{"snapshot missing id", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, "/x", `{"name":"snap"}`, missingID, true, true, defaultService, http.StatusBadRequest},
		{"snapshot invalid body", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, "/x", "{", validID, true, true, defaultService, http.StatusBadRequest},
		{"snapshot service error", (*WorkspaceHandler).CreateWorkspaceSnapshot, http.MethodPost, "/x", `{"name":"snap"}`, validID, true, true, errorService, http.StatusNotFound},
		{"snapshot template no auth", (*WorkspaceHandler).CreateWorkspaceSnapshotTemplate, http.MethodPost, "/x", `{"workspace_id":"ws-1"}`, nil, false, true, defaultService, http.StatusUnauthorized},
		{"snapshot template no repo", (*WorkspaceHandler).CreateWorkspaceSnapshotTemplate, http.MethodPost, "/x", `{"workspace_id":"ws-1"}`, nil, true, false, defaultService, http.StatusBadRequest},
		{"snapshot template invalid body", (*WorkspaceHandler).CreateWorkspaceSnapshotTemplate, http.MethodPost, "/x", "{", nil, true, true, defaultService, http.StatusBadRequest},
		{"snapshot template service error", (*WorkspaceHandler).CreateWorkspaceSnapshotTemplate, http.MethodPost, "/x", `{"workspace_id":"ws-1"}`, nil, true, true, errorService, http.StatusNotFound},
		{"get snapshot no auth", (*WorkspaceHandler).GetWorkspaceSnapshot, http.MethodGet, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"get snapshot no repo", (*WorkspaceHandler).GetWorkspaceSnapshot, http.MethodGet, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"get snapshot missing id", (*WorkspaceHandler).GetWorkspaceSnapshot, http.MethodGet, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"get snapshot service error", (*WorkspaceHandler).GetWorkspaceSnapshot, http.MethodGet, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"list snapshots no auth", (*WorkspaceHandler).ListWorkspaceSnapshots, http.MethodGet, "/x", "", nil, false, true, defaultService, http.StatusUnauthorized},
		{"list snapshots no repo", (*WorkspaceHandler).ListWorkspaceSnapshots, http.MethodGet, "/x", "", nil, true, false, defaultService, http.StatusBadRequest},
		{"list snapshots invalid pagination", (*WorkspaceHandler).ListWorkspaceSnapshots, http.MethodGet, "/x?limit=bad", "", nil, true, true, defaultService, http.StatusBadRequest},
		{"list snapshots service error", (*WorkspaceHandler).ListWorkspaceSnapshots, http.MethodGet, "/x", "", nil, true, true, errorService, http.StatusNotFound},
		{"delete snapshot no auth", (*WorkspaceHandler).DeleteWorkspaceSnapshot, http.MethodDelete, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"delete snapshot no repo", (*WorkspaceHandler).DeleteWorkspaceSnapshot, http.MethodDelete, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"delete snapshot missing id", (*WorkspaceHandler).DeleteWorkspaceSnapshot, http.MethodDelete, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"delete snapshot service error", (*WorkspaceHandler).DeleteWorkspaceSnapshot, http.MethodDelete, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"create session no auth", (*WorkspaceHandler).CreateSession, http.MethodPost, "/x", `{"cols":80,"rows":24}`, nil, false, true, defaultService, http.StatusUnauthorized},
		{"create session no repo", (*WorkspaceHandler).CreateSession, http.MethodPost, "/x", `{"cols":80,"rows":24}`, nil, true, false, defaultService, http.StatusBadRequest},
		{"create session invalid body", (*WorkspaceHandler).CreateSession, http.MethodPost, "/x", "{", nil, true, true, defaultService, http.StatusBadRequest},
		{"create session service error", (*WorkspaceHandler).CreateSession, http.MethodPost, "/x", `{"cols":80,"rows":24}`, nil, true, true, errorService, http.StatusNotFound},
		{"get session no auth", (*WorkspaceHandler).GetSession, http.MethodGet, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"get session no repo", (*WorkspaceHandler).GetSession, http.MethodGet, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"get session missing id", (*WorkspaceHandler).GetSession, http.MethodGet, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"get session service error", (*WorkspaceHandler).GetSession, http.MethodGet, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"list sessions no auth", (*WorkspaceHandler).ListSessions, http.MethodGet, "/x", "", nil, false, true, defaultService, http.StatusUnauthorized},
		{"list sessions no repo", (*WorkspaceHandler).ListSessions, http.MethodGet, "/x", "", nil, true, false, defaultService, http.StatusBadRequest},
		{"list sessions invalid pagination", (*WorkspaceHandler).ListSessions, http.MethodGet, "/x?limit=bad", "", nil, true, true, defaultService, http.StatusBadRequest},
		{"list sessions service error", (*WorkspaceHandler).ListSessions, http.MethodGet, "/x", "", nil, true, true, errorService, http.StatusNotFound},
		{"session ssh no auth", (*WorkspaceHandler).GetSSHConnectionInfo, http.MethodGet, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"session ssh no repo", (*WorkspaceHandler).GetSSHConnectionInfo, http.MethodGet, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"session ssh missing id", (*WorkspaceHandler).GetSSHConnectionInfo, http.MethodGet, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"session ssh service error", (*WorkspaceHandler).GetSSHConnectionInfo, http.MethodGet, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"destroy session no auth", (*WorkspaceHandler).DestroySession, http.MethodPost, "/x", "", validID, false, true, defaultService, http.StatusUnauthorized},
		{"destroy session no repo", (*WorkspaceHandler).DestroySession, http.MethodPost, "/x", "", validID, true, false, defaultService, http.StatusBadRequest},
		{"destroy session missing id", (*WorkspaceHandler).DestroySession, http.MethodPost, "/x", "", missingID, true, true, defaultService, http.StatusBadRequest},
		{"destroy session service error", (*WorkspaceHandler).DestroySession, http.MethodPost, "/x", "", validID, true, true, errorService, http.StatusNotFound},
		{"user workspaces service error", (*WorkspaceHandler).GetUserWorkspaces, http.MethodGet, "/x", "", nil, true, false, errorService, http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &WorkspaceHandler{Service: tt.service}
			req := workspaceHRequest(tt.method, tt.target, tt.body, tt.params, tt.authed, tt.withRepo)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestWorkspace_H_StreamMetricsConfigured(t *testing.T) {
	h := &WorkspaceHandler{
		Service: &mockWorkspaceRouteService{
			getWorkspaceFn: func(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
				return services.WorkspaceResponse{ID: "ws-1"}, nil
			},
			getSessionFn: func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
				return services.WorkspaceSessionResponse{ID: "session-1"}, nil
			},
		},
		Metrics: NewSmithersMetrics(),
	}

	workspaceReq := workspaceHRequest(http.MethodGet, "/x", "", map[string]string{"id": "ws-1"}, true, true)
	workspaceRec := httptest.NewRecorder()
	h.StreamWorkspace(workspaceRec, workspaceReq)
	require.Equal(t, http.StatusInternalServerError, workspaceRec.Code)

	sessionReq := workspaceHRequest(http.MethodGet, "/x", "", map[string]string{"id": "session-1"}, true, true)
	sessionRec := httptest.NewRecorder()
	h.StreamSession(sessionRec, sessionReq)
	require.Equal(t, http.StatusInternalServerError, sessionRec.Code)
}
