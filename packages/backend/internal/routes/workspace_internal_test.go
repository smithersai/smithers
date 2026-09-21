package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockWorkspaceInternalRouteService struct {
	updatePodStatusFn func(ctx context.Context, input services.UpdateWorkspacePodStatusInput) error
	updateHeadFn      func(ctx context.Context, input services.UpdateWorkspaceHeadInput) error
}

func (m *mockWorkspaceInternalRouteService) UpdateWorkspaceHead(ctx context.Context, input services.UpdateWorkspaceHeadInput) error {
	if m.updateHeadFn != nil {
		return m.updateHeadFn(ctx, input)
	}
	return nil
}

func TestWorkspaceInternalHandler_PostWorkspaceHead_Success(t *testing.T) {
	t.Parallel()
	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{
		updateHeadFn: func(_ context.Context, input services.UpdateWorkspaceHeadInput) error {
			assert.Equal(t, "ws-123", input.WorkspaceID)
			assert.Equal(t, "change-1", input.ChangeID)
			assert.Equal(t, "commit-1", input.CommitID)
			assert.Equal(t, int32(3), input.Ahead)
			assert.Equal(t, int32(1), input.Behind)
			return nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-123/head", strings.NewReader(`{"change_id":"change-1","commit_id":"commit-1","ahead":3,"behind":1}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-123"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceHead(rec, req)
	require.Equal(t, http.StatusAccepted, rec.Code)
}

func (m *mockWorkspaceInternalRouteService) UpdateWorkspacePodStatus(ctx context.Context, input services.UpdateWorkspacePodStatusInput) error {
	if m.updatePodStatusFn != nil {
		return m.updatePodStatusFn(ctx, input)
	}
	return nil
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_Success(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{
		updatePodStatusFn: func(ctx context.Context, input services.UpdateWorkspacePodStatusInput) error {
			assert.Equal(t, "ws-123", input.WorkspaceID)
			assert.Equal(t, "running", input.Status)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-123/status", strings.NewReader(`{"status":"running"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-123"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_MissingID(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace//status", strings.NewReader(`{"status":"running"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": ""})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_MissingStatus(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-123/status", strings.NewReader(`{"status":""}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-123"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_NilService(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: nil}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-123/status", strings.NewReader(`{"status":"running"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-123"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_ServiceError(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{
		updatePodStatusFn: func(ctx context.Context, input services.UpdateWorkspacePodStatusInput) error {
			return pkgerrors.NotFound("workspace not found")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-gone/status", strings.NewReader(`{"status":"failed"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-gone"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkspaceInternalHandler_PostWorkspaceStatus_InvalidJSON(t *testing.T) {
	t.Parallel()

	h := &WorkspaceInternalHandler{Service: &mockWorkspaceInternalRouteService{}}

	req := httptest.NewRequest(http.MethodPost, "/internal/workspace/ws-123/status", strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"id": "ws-123"})
	rec := httptest.NewRecorder()
	h.PostWorkspaceStatus(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}
