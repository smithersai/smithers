package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ─── RerunWorkflowRun ─────────────────────────────────────────────────────────

func TestWorkflowHandler_RerunWorkflowRun_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/1/rerun", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.RerunWorkflowRun(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_RerunWorkflowRun_RequiresAuth_Returns401(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/1/rerun", nil)
	req = withRepoContext(req, "alice", "demo")
	// No auth context
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.RerunWorkflowRun(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkflowHandler_RerunWorkflowRun_InvalidRunID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/abc/rerun", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.RerunWorkflowRun(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_RerunWorkflowRun_ServiceNotFound_Returns404(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		rerunRunFn: func(_ context.Context, _ services.RerunInput) (*services.WorkflowRunResult, error) {
			return nil, pkgerrors.NotFound("workflow run not found")
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/999/rerun", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "999"})
	rec := httptest.NewRecorder()
	h.RerunWorkflowRun(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowHandler_RerunWorkflowRun_DelegatesAndReturns201(t *testing.T) {
	t.Parallel()
	var capturedInput services.RerunInput
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		rerunRunFn: func(_ context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
			capturedInput = input
			return &services.WorkflowRunResult{
				WorkflowRunID:        100,
				WorkflowDefinitionID: 7,
				Steps: []services.WorkflowStepResult{
					{StepID: 1, TaskID: 10},
					{StepID: 2, TaskID: 20},
				},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/5/rerun", strings.NewReader(`{}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 42, "alice")
	req = withRouteParams(req, map[string]string{"id": "5"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.RerunWorkflowRun(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, int64(101), capturedInput.RepositoryID)
	assert.Equal(t, int64(5), capturedInput.RunID)
	assert.Equal(t, int64(42), capturedInput.UserID)

	// Verify response body
	body := rec.Body.String()
	assert.Contains(t, body, `"workflow_run_id":100`)
	assert.Contains(t, body, `"workflow_definition_id":7`)
}
