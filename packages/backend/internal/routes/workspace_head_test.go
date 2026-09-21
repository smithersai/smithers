package routes

import (
	"context"
	"encoding/json"

	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkspaceHeadRetainSourceModeRejectsMixedFieldsIncludingZeroValues(t *testing.T) {
	for _, suffix := range []string{``, `,"ahead":0`, `,"change_id":""`, `,"coding_operations":[]`, `,"token":"forged"`} {
		var request reportWorkspaceHeadRequest
		err := json.Unmarshal([]byte(`{"retain_source":{"change_id":"native","commit_id":"source","tree_id":"tree","parent_commit_ids":[]}`+suffix+`}`), &request)
		if suffix == "" {
			require.NoError(t, err)
			require.NotNil(t, request.RetainSource)
			require.Equal(t, "source", request.RetainSource.CommitID)
		} else {
			require.Error(t, err)
		}
	}
}

type mockWorkspaceHeadRouteService struct {
	mockWorkspaceRouteService
	reportFn func(ctx context.Context, input services.ReportWorkspaceHeadInput) (services.WorkspaceResponse, error)
}

func (m *mockWorkspaceHeadRouteService) ReportWorkspaceHead(ctx context.Context, input services.ReportWorkspaceHeadInput) (services.WorkspaceResponse, error) {
	return m.reportFn(ctx, input)
}

func TestWorkspaceHandler_ReportWorkspaceHead(t *testing.T) {
	t.Parallel()
	const workspaceID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	var got services.ReportWorkspaceHeadInput
	svc := &mockWorkspaceHeadRouteService{reportFn: func(_ context.Context, input services.ReportWorkspaceHeadInput) (services.WorkspaceResponse, error) {
		got = input
		return services.WorkspaceResponse{ID: input.WorkspaceID, Head: services.WorkspaceHead{ChangeID: input.ChangeID, CommitID: input.CommitID}}, nil
	}}
	h := &WorkspaceHandler{Service: svc}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/"+workspaceID+"/head",
		strings.NewReader(`{"change_id":"kxyz","commit_id":"abc123","ahead":2,"behind":1}`))
	req.Header.Set("Content-Type", "application/json")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7},
		IsTokenAuth: true,
		RawScopes:   "write:repository,repo:200," + middleware.WorkspaceRestrictionScope(workspaceID),
	}))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", workspaceID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.ReportWorkspaceHead(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, workspaceID, got.WorkspaceID)
	assert.Equal(t, int64(200), got.RepositoryID)
	assert.Equal(t, int64(7), got.UserID)
	assert.Equal(t, workspaceID, got.TokenWorkspaceID)
	assert.Equal(t, "abc123", got.CommitID)
	assert.Equal(t, int32(2), got.Ahead)
	assert.Contains(t, rec.Body.String(), `"commit_id":"abc123"`)
}

func TestWorkspaceHandler_ReportWorkspaceHead_RequiresAuth(t *testing.T) {
	t.Parallel()
	h := &WorkspaceHandler{Service: &mockWorkspaceHeadRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/x/head", strings.NewReader(`{}`))
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ReportWorkspaceHead(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
