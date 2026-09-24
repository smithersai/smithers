package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ─── Mock service ──────────────────────────────────────────────────────────────

type mockWorkflowRouteService struct {
	listWorkflowDefinitionsFn func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error)
	getWorkflowDefinitionFn   func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error)
	listWorkflowRunsByRepoFn  func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error)
	listWorkflowRunsByDefFn   func(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error)
	getWorkflowRunFn          func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	cancelWorkflowRunFn       func(ctx context.Context, repositoryID, runID int64) error
	dispatchForEventFn        func(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
	rerunRunFn                func(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error)
	resumeRunFn               func(ctx context.Context, repositoryID, runID int64) error
	invokeWorkflowFn          func(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error)
}

func (m *mockWorkflowRouteService) ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
	if m.listWorkflowDefinitionsFn != nil {
		return m.listWorkflowDefinitionsFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (m *mockWorkflowRouteService) GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
	if m.getWorkflowDefinitionFn != nil {
		return m.getWorkflowDefinitionFn(ctx, repositoryID, definitionID)
	}
	return db.WorkflowDefinition{}, pkgerrors.NotFound("workflow definition not found")
}

func (m *mockWorkflowRouteService) ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if m.listWorkflowRunsByRepoFn != nil {
		return m.listWorkflowRunsByRepoFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (m *mockWorkflowRouteService) ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if m.listWorkflowRunsByDefFn != nil {
		return m.listWorkflowRunsByDefFn(ctx, repositoryID, definitionID, page, perPage)
	}
	return nil, nil
}

func (m *mockWorkflowRouteService) GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, repositoryID, runID)
	}
	return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
}

func (m *mockWorkflowRouteService) CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error {
	if m.cancelWorkflowRunFn != nil {
		return m.cancelWorkflowRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockWorkflowRouteService) RerunRun(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
	if m.rerunRunFn != nil {
		return m.rerunRunFn(ctx, input)
	}
	return &services.WorkflowRunResult{WorkflowRunID: 999, WorkflowDefinitionID: input.RepositoryID}, nil
}

func (m *mockWorkflowRouteService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if m.resumeRunFn != nil {
		return m.resumeRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockWorkflowRouteService) DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}
func (m *mockWorkflowRouteService) InvokeWorkflow(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
	if m.invokeWorkflowFn != nil {
		return m.invokeWorkflowFn(ctx, input)
	}
	return nil, pkgerrors.NotFound("workflow definition not found")
}

func (m *mockWorkflowRouteService) ListWorkflowSteps(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
	return nil, nil
}

func (m *mockWorkflowRouteService) ListWorkflowLogsSince(_ context.Context, _, _ int64, _ int32) ([]db.WorkflowLog, error) {
	return nil, nil
}

var _ WorkflowRouteService = (*mockWorkflowRouteService)(nil)

// ─── Helpers ──────────────────────────────────────────────────────────────────

func makeWFDef(id, repoID int64, name string) db.WorkflowDefinition {
	return db.WorkflowDefinition{
		ID:           id,
		RepositoryID: repoID,
		Name:         name,
		Path:         ".smithers/workflows/" + name + ".tsx",
		Config:       json.RawMessage(`{"on":{"push":{}},"jobs":{}}`),
		IsActive:     true,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
}

func makeWFRun(id, repoID, defID int64, status string) db.WorkflowRun {
	return db.WorkflowRun{
		ID:                   id,
		RepositoryID:         repoID,
		WorkflowDefinitionID: defID,
		Status:               status,
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
		CreatedAt:            time.Now(),
		UpdatedAt:            time.Now(),
	}
}

// ─── ListWorkflows ────────────────────────────────────────────────────────────

func TestWorkflowHandler_ListWorkflows_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListWorkflows(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_ListWorkflows_DelegatesToService(t *testing.T) {
	t.Parallel()
	defs := []db.WorkflowDefinition{
		makeWFDef(1, 101, "ci"),
		makeWFDef(2, 101, "deploy"),
	}
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		listWorkflowDefinitionsFn: func(_ context.Context, repoID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return defs, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListWorkflows(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp listWorkflowsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Workflows, 2)
	assert.Equal(t, "ci", resp.Workflows[0].Name)
}

func TestWorkflowHandler_ListWorkflows_InvalidPagination_ReturnsBadRequest(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		listWorkflowDefinitionsFn: func(_ context.Context, _ int64, page, perPage int) ([]db.WorkflowDefinition, error) {
			return nil, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows?page=invalid&per_page=abc", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListWorkflows(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

// ─── GetWorkflow ──────────────────────────────────────────────────────────────

func TestWorkflowHandler_GetWorkflow_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/1", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.GetWorkflow(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_GetWorkflow_InvalidID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/abc", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.GetWorkflow(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_GetWorkflow_NotFound_Returns404(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, _, _ int64) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pkgerrors.NotFound("not found")
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/999", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "999"})
	rec := httptest.NewRecorder()
	h.GetWorkflow(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowHandler_GetWorkflow_DelegatesAndReturns200(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, int64(7), defID)
			return makeWFDef(7, 101, "test-wf"), nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/7", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec := httptest.NewRecorder()
	h.GetWorkflow(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp workflowDefinitionResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, int64(7), resp.ID)
	assert.Equal(t, "test-wf", resp.Name)
}

// ─── ListWorkflowRuns ─────────────────────────────────────────────────────────

func TestWorkflowHandler_ListWorkflowRuns_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/1/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.ListWorkflowRuns(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_ListWorkflowRuns_InvalidDefinitionID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/abc/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.ListWorkflowRuns(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_ListWorkflowRuns_ByDefinition_DelegatesToService(t *testing.T) {
	t.Parallel()
	runs := []db.WorkflowRun{
		makeWFRun(1, 101, 7, "completed"),
		makeWFRun(2, 101, 7, "running"),
	}
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(7, repoID, "test-wf"), nil
		},
		listWorkflowRunsByDefFn: func(_ context.Context, repoID, defID int64, page, perPage int) ([]db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, int64(7), defID)
			return runs, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/7/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec := httptest.NewRecorder()
	h.ListWorkflowRuns(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp listWorkflowRunsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.WorkflowRuns, 2)
}

func TestWorkflowHandler_ListAllWorkflowRuns_DelegatesToService(t *testing.T) {
	t.Parallel()
	runs := []db.WorkflowRun{
		makeWFRun(1, 101, 1, "completed"),
		makeWFRun(2, 101, 2, "running"),
	}
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		listWorkflowRunsByRepoFn: func(_ context.Context, repoID int64, page, perPage int) ([]db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return runs, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	h.ListAllWorkflowRuns(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp listWorkflowRunsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.WorkflowRuns, 2)
	assert.Equal(t, int64(1), resp.WorkflowRuns[0].ID)
	assert.Equal(t, int64(2), resp.WorkflowRuns[1].ID)
}

// ─── GetWorkflowRun ───────────────────────────────────────────────────────────

func TestWorkflowHandler_GetWorkflowRun_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/1", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRun(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_GetWorkflowRun_InvalidID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/abc", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRun(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_GetWorkflowRun_NotFound_Returns404(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pkgerrors.NotFound("not found")
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/999", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "999"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRun(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowHandler_GetWorkflowRun_DelegatesAndReturns200(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, int64(7), runID)
			run := makeWFRun(7, 101, 1, "completed")
			run.CheckRunID = pgtype.Int8{Int64: 1234, Valid: true}
			run.CheckRunUrl = pgtype.Text{String: "https://github.com/acme/demo/runs/1234", Valid: true}
			return run, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/7", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec := httptest.NewRecorder()
	h.GetWorkflowRun(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var resp workflowRunResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, int64(7), resp.ID)
	assert.Equal(t, "completed", resp.Status)
	require.NotNil(t, resp.CheckRunID)
	assert.Equal(t, int64(1234), *resp.CheckRunID)
	require.NotNil(t, resp.CheckRunURL)
	assert.Equal(t, "https://github.com/acme/demo/runs/1234", *resp.CheckRunURL)
}

// ─── CancelWorkflowRun ───────────────────────────────────────────────────────

func TestWorkflowHandler_CancelWorkflowRun_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/1/cancel", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.CancelWorkflowRun(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_CancelWorkflowRun_InvalidID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/abc/cancel", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.CancelWorkflowRun(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_CancelWorkflowRun_DelegatesAndReturns204(t *testing.T) {
	t.Parallel()
	var capturedRepoID int64
	var capturedRunID int64
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		cancelWorkflowRunFn: func(_ context.Context, repositoryID, runID int64) error {
			capturedRepoID = repositoryID
			capturedRunID = runID
			return nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/7/cancel", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec := httptest.NewRecorder()
	h.CancelWorkflowRun(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, int64(101), capturedRepoID)
	assert.Equal(t, int64(7), capturedRunID)
}

func TestWorkflowHandler_CancelWorkflowRun_ServiceNotFound_Returns404(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		cancelWorkflowRunFn: func(_ context.Context, _, _ int64) error {
			return pkgerrors.NotFound("workflow run not found")
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/999/cancel", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "999"})
	rec := httptest.NewRecorder()
	h.CancelWorkflowRun(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// ─── DispatchWorkflow ─────────────────────────────────────────────────────────

func TestWorkflowHandler_DispatchWorkflow_NilService_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/1/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowHandler_DispatchWorkflow_RequiresAuth_Returns401(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/1/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	// No auth context
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkflowHandler_DispatchWorkflow_InvalidDefinitionID_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/abc/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "abc"})
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_DispatchWorkflow_InvalidBody_Returns400(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(1, repoID, "test-wf"), nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/1/dispatches", strings.NewReader(`{invalid json`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowHandler_DispatchWorkflow_DelegatesAndReturns201WithRunID(t *testing.T) {
	t.Parallel()
	var capturedInput services.DispatchForEventInput
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(7, repoID, "test-wf"), nil
		},
		dispatchForEventFn: func(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			capturedInput = input
			return []services.WorkflowRunResult{
				{WorkflowRunID: 100, WorkflowDefinitionID: 7},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{"ref":"feature-branch"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 42, "alice")
	req = withRouteParams(req, map[string]string{"id": "7"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, int64(101), capturedInput.RepositoryID)
	require.NotNil(t, capturedInput.WorkflowDefinitionID)
	assert.Equal(t, int64(7), *capturedInput.WorkflowDefinitionID)
	assert.Equal(t, "workflow_dispatch", capturedInput.Event.Type)
	assert.Equal(t, "feature-branch", capturedInput.Event.Ref)

	var resp dispatchResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Runs, 1)
	assert.Equal(t, int64(100), resp.Runs[0].WorkflowRunID)
	assert.Equal(t, int64(7), resp.Runs[0].WorkflowDefinitionID)
}

func TestWorkflowHandler_DispatchWorkflow_ServiceError_Returns500(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(1, repoID, "test-wf"), nil
		},
		dispatchForEventFn: func(_ context.Context, _ services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			return nil, errors.New("database error")
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/1/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "1"})
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// withRepoContextAndBookmark creates a repo context with a custom default bookmark.
func withRepoContextAndBookmark(req *http.Request, owner, repo, defaultBookmark string) *http.Request {
	repository := &db.Repository{ID: 101, Name: repo, LowerName: repo, DefaultBookmark: defaultBookmark}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      owner,
		Repository: repository,
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func TestWorkflowHandler_DispatchWorkflow_NoRef_UsesRepoDefaultBookmark(t *testing.T) {
	t.Parallel()
	var capturedInput services.DispatchForEventInput
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(7, repoID, "test-wf"), nil
		},
		dispatchForEventFn: func(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			capturedInput = input
			return []services.WorkflowRunResult{
				{WorkflowRunID: 100, WorkflowDefinitionID: 7},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{}`))
	req = withRepoContextAndBookmark(req, "alice", "demo", "develop")
	req = withAuth(req, 42, "alice")
	req = withRouteParams(req, map[string]string{"id": "7"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, "workflow_dispatch", capturedInput.Event.Type)
	assert.Equal(t, "develop", capturedInput.Event.Ref, "empty ref should default to repository's default bookmark, not hardcoded 'main'")
}

func TestWorkflowHandler_DispatchWorkflow_WithRef_UsesSpecifiedRef(t *testing.T) {
	t.Parallel()
	var capturedInput services.DispatchForEventInput
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(7, repoID, "test-wf"), nil
		},
		dispatchForEventFn: func(_ context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			capturedInput = input
			return []services.WorkflowRunResult{
				{WorkflowRunID: 100, WorkflowDefinitionID: 7},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{"ref":"feature-x"}`))
	req = withRepoContextAndBookmark(req, "alice", "demo", "develop")
	req = withAuth(req, 42, "alice")
	req = withRouteParams(req, map[string]string{"id": "7"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, "workflow_dispatch", capturedInput.Event.Type)
	assert.Equal(t, "feature-x", capturedInput.Event.Ref, "explicit ref should be used, not the default bookmark")
}

// ─── Dispatch → Run ID contract ──────────────────────────────────────────────

// TestDispatchWorkflow_ResponseContainsRunID verifies that the dispatch endpoint
// returns the created run's ID in both the canonical "id" field and the legacy
// "workflow_run_id" field so the CLI can poll run status using either key.
func TestDispatchWorkflow_ResponseContainsRunID(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(7, repoID, "ci"), nil
		},
		dispatchForEventFn: func(_ context.Context, _ services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			return []services.WorkflowRunResult{
				{
					WorkflowRunID:        42,
					WorkflowDefinitionID: 7,
					Steps: []services.WorkflowStepResult{
						{StepID: 1, TaskID: 10, Position: 1},
					},
				},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "7"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)

	// Decode as generic JSON to verify exact field names and values.
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))

	runsRaw, ok := raw["runs"]
	require.True(t, ok, "response must contain a 'runs' array")

	var runs []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(runsRaw, &runs))
	require.Len(t, runs, 1)

	run := runs[0]

	// "id" and "workflow_run_id" must both be present and equal.
	idRaw, hasID := run["id"]
	require.True(t, hasID, "run object must contain 'id' field")
	wridRaw, hasWRID := run["workflow_run_id"]
	require.True(t, hasWRID, "run object must contain 'workflow_run_id' field")
	assert.Equal(t, string(idRaw), string(wridRaw), "'id' and 'workflow_run_id' must have identical values")

	var runID int64
	require.NoError(t, json.Unmarshal(idRaw, &runID))
	assert.Equal(t, int64(42), runID)

	// Steps must serialize with snake_case field names and include position.
	stepsRaw, hasSteps := run["steps"]
	require.True(t, hasSteps, "run object must contain 'steps' array")

	var steps []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(stepsRaw, &steps))
	require.Len(t, steps, 1)

	step := steps[0]
	_, hasStepID := step["step_id"]
	assert.True(t, hasStepID, "step must use snake_case 'step_id' (not 'StepID')")
	_, hasTaskID := step["task_id"]
	assert.True(t, hasTaskID, "step must use snake_case 'task_id' (not 'TaskID')")
	_, hasPosition := step["position"]
	assert.True(t, hasPosition, "step must include 'position' for deterministic job ordering")

	var pos int64
	require.NoError(t, json.Unmarshal(step["position"], &pos))
	assert.Equal(t, int64(1), pos)
}

// TestDispatchWorkflow_RunIDCanPollStatus verifies the end-to-end contract:
// dispatch returns a run ID that the caller can immediately use with
// GetWorkflowRun to poll the run status.
func TestDispatchWorkflow_RunIDCanPollStatus(t *testing.T) {
	t.Parallel()

	const runID = int64(77)

	svc := &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(defID, repoID, "ci"), nil
		},
		dispatchForEventFn: func(_ context.Context, _ services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			return []services.WorkflowRunResult{
				{WorkflowRunID: runID, WorkflowDefinitionID: 3},
			}, nil
		},
		getWorkflowRunFn: func(_ context.Context, _, gotRunID int64) (db.WorkflowRun, error) {
			if gotRunID != runID {
				return db.WorkflowRun{}, pkgerrors.NotFound("run not found")
			}
			return makeWFRun(runID, 101, 3, "queued"), nil
		},
	}
	h := WorkflowHandler{Service: svc}

	// Step 1: dispatch the workflow.
	dispatchReq := httptest.NewRequest(
		http.MethodPost,
		"/api/repos/alice/demo/workflows/3/dispatches",
		strings.NewReader(`{"ref":"main"}`),
	)
	dispatchReq = withRepoContext(dispatchReq, "alice", "demo")
	dispatchReq = withAuth(dispatchReq, 1, "alice")
	dispatchReq = withRouteParams(dispatchReq, map[string]string{"id": "3"})
	dispatchReq.Header.Set("Content-Type", "application/json")
	dispatchRec := httptest.NewRecorder()
	h.DispatchWorkflow(dispatchRec, dispatchReq)
	require.Equal(t, http.StatusCreated, dispatchRec.Code)

	var dispatchResp dispatchResponse
	require.NoError(t, json.Unmarshal(dispatchRec.Body.Bytes(), &dispatchResp))
	require.Len(t, dispatchResp.Runs, 1)

	// Extract the run ID that the CLI would use for polling.
	returnedRunID := dispatchResp.Runs[0].WorkflowRunID
	require.Equal(t, runID, returnedRunID, "dispatch response must carry the created run ID")
	require.Equal(t, returnedRunID, dispatchResp.Runs[0].ID, "'id' field must equal 'workflow_run_id'")

	// Step 2: poll run status using the returned run ID.
	statusReq := httptest.NewRequest(
		http.MethodGet,
		"/api/repos/alice/demo/runs/77",
		nil,
	)
	statusReq = withRepoContext(statusReq, "alice", "demo")
	statusReq = withAuth(statusReq, 1, "alice")
	statusReq = withRouteParams(statusReq, map[string]string{"id": "77"})
	statusRec := httptest.NewRecorder()
	h.GetWorkflowRun(statusRec, statusReq)
	require.Equal(t, http.StatusOK, statusRec.Code)

	var runResp workflowRunResponse
	require.NoError(t, json.Unmarshal(statusRec.Body.Bytes(), &runResp))
	assert.Equal(t, returnedRunID, runResp.ID, "polled run ID must match dispatched run ID")
	assert.Equal(t, "queued", runResp.Status)
}

// TestDispatchWorkflow_JobOrderingIsDeterministic verifies that steps in the
// dispatch response carry ascending position values that correspond to the
// deterministic (alphabetical by job name) order in which jobs are scheduled.
func TestDispatchWorkflow_JobOrderingIsDeterministic(t *testing.T) {
	t.Parallel()
	h := WorkflowHandler{Service: &mockWorkflowRouteService{
		getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
			return makeWFDef(defID, repoID, "ci"), nil
		},
		dispatchForEventFn: func(_ context.Context, _ services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			// Return steps in the order the service produces them: position 1, 2, 3
			// sorted alphabetically by job name (build < lint < test).
			return []services.WorkflowRunResult{
				{
					WorkflowRunID:        10,
					WorkflowDefinitionID: 5,
					Steps: []services.WorkflowStepResult{
						{StepID: 1, TaskID: 101, Position: 1}, // "build"
						{StepID: 2, TaskID: 102, Position: 2}, // "lint"
						{StepID: 3, TaskID: 103, Position: 3}, // "test"
					},
				},
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/5/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 1, "alice")
	req = withRouteParams(req, map[string]string{"id": "5"})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.DispatchWorkflow(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	var resp dispatchResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Runs, 1)
	steps := resp.Runs[0].Steps
	require.Len(t, steps, 3)

	// Positions must be monotonically increasing — this is the contract the DB
	// enforces (UNIQUE (workflow_run_id, position)) and the service honors by
	// sorting jobs alphabetically before insertion.
	for i := 1; i < len(steps); i++ {
		assert.Greater(t, steps[i].Position, steps[i-1].Position,
			"step at index %d must have a higher position than step at index %d", i, i-1)
	}
	assert.Equal(t, int64(1), steps[0].Position)
	assert.Equal(t, int64(2), steps[1].Position)
	assert.Equal(t, int64(3), steps[2].Position)
}

func (m *mockWorkflowRouteService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
