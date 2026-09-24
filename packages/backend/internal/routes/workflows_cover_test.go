package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkflows_Cov_ListRunSteps(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	started := time.Unix(101, 0).UTC()
	completed := time.Unix(102, 0).UTC()

	t.Run("nil service and missing repo context", func(t *testing.T) {
		h := WorkflowHandler{}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/5/steps", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)

		h = WorkflowHandler{Service: &workflowsCovRouteService{}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/5/steps", nil)
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec = httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid run id stops before service", func(t *testing.T) {
		called := false
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowRunFn: func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
				called = true
				return db.WorkflowRun{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/0/steps", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "0"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("verifies run belongs to repo before listing steps", func(t *testing.T) {
		listCalled := false
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowRunFn: func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, int64(5), runID)
				return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
			},
			listWorkflowStepsFn: func(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
				listCalled = true
				return nil, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/5/steps", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, listCalled)
	})

	t.Run("returns serialized step timestamps", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowRunFn: func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repositoryID, 9, "running"), nil
			},
			listWorkflowStepsFn: func(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
				assert.Equal(t, int64(5), runID)
				return []db.WorkflowStep{{
					ID:            10,
					WorkflowRunID: runID,
					Name:          "build",
					Position:      1,
					Status:        "completed",
					StartedAt:     pgtype.Timestamptz{Time: started, Valid: true},
					CompletedAt:   pgtype.Timestamptz{Time: completed, Valid: true},
					CreatedAt:     now,
					UpdatedAt:     completed,
				}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/5/steps", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body listWorkflowStepsResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body.Steps, 1)
		assert.Equal(t, int64(10), body.Steps[0].ID)
		require.NotNil(t, body.Steps[0].StartedAt)
		require.NotNil(t, body.Steps[0].CompletedAt)
		assert.Equal(t, started, *body.Steps[0].StartedAt)
		assert.Equal(t, completed, *body.Steps[0].CompletedAt)
	})

	t.Run("step list service error is propagated", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowRunFn: func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repositoryID, 9, "running"), nil
			},
			listWorkflowStepsFn: func(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
				return nil, pkgerrors.Forbidden("cannot inspect run")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/5/steps", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRunSteps(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestWorkflows_Cov_OtherMissingBranches(t *testing.T) {
	t.Run("list workflows requires repo context and propagates service errors", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows", nil)
		rec := httptest.NewRecorder()

		h.ListWorkflows(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)

		h = WorkflowHandler{Service: &workflowsCovRouteService{
			listWorkflowDefinitionsFn: func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
				return nil, pkgerrors.Forbidden("repo blocked")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows", nil)
		req = withRepoContext(req, "alice", "demo")
		rec = httptest.NewRecorder()

		h.ListWorkflows(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("list workflow runs handles definition lookup and list errors", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowDefinitionFn: func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
				return db.WorkflowDefinition{}, pkgerrors.NotFound("workflow definition not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/7/runs", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "7"})
		rec := httptest.NewRecorder()

		h.ListWorkflowRuns(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)

		h = WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowDefinitionFn: func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
				return makeWFDef(definitionID, repositoryID, "ci"), nil
			},
			listWorkflowRunsByDefinitionFn: func(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error) {
				return nil, pkgerrors.Forbidden("cannot list runs")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/7/runs", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "7"})
		rec = httptest.NewRecorder()

		h.ListWorkflowRuns(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("list all workflow runs validates pagination and service errors", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs?page=bad", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.ListAllWorkflowRuns(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = WorkflowHandler{Service: &workflowsCovRouteService{
			listWorkflowRunsByRepoFn: func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
				return nil, pkgerrors.Forbidden("blocked")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs", nil)
		req = withRepoContext(req, "alice", "demo")
		rec = httptest.NewRecorder()

		h.ListAllWorkflowRuns(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("dispatch validates schema and optional rerun body", func(t *testing.T) {
		h := WorkflowHandler{Service: &workflowsCovRouteService{
			getWorkflowDefinitionFn: func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
				def := makeWFDef(definitionID, repositoryID, "manual")
				def.Config = json.RawMessage(`{"on":{"workflow_dispatch":{"inputs":{"env":{"required":true}}}}}`)
				return def, nil
			},
			dispatchForEventFn: func(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
				return nil, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{"inputs":{}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		req = withRouteParams(req, map[string]string{"id": "7"})
		rec := httptest.NewRecorder()

		h.DispatchWorkflow(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)

		h = WorkflowHandler{Service: &workflowsCovRouteService{
			rerunRunFn: func(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
				return nil, nil
			},
		}}
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/5/rerun", strings.NewReader(`{bad`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		req = withRouteParams(req, map[string]string{"id": "5"})
		rec = httptest.NewRecorder()

		h.RerunWorkflowRun(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

type workflowsCovRouteService struct {
	listWorkflowDefinitionsFn      func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error)
	getWorkflowDefinitionFn        func(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error)
	listWorkflowRunsByRepoFn       func(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error)
	listWorkflowRunsByDefinitionFn func(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error)
	getWorkflowRunFn               func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	cancelWorkflowRunFn            func(ctx context.Context, repositoryID, runID int64) error
	resumeRunFn                    func(ctx context.Context, repositoryID, runID int64) error
	dispatchForEventFn             func(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
	rerunRunFn                     func(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error)
	listWorkflowStepsFn            func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn        func(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

func (s *workflowsCovRouteService) ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
	if s.listWorkflowDefinitionsFn != nil {
		return s.listWorkflowDefinitionsFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (s *workflowsCovRouteService) GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
	if s.getWorkflowDefinitionFn != nil {
		return s.getWorkflowDefinitionFn(ctx, repositoryID, definitionID)
	}
	return makeWFDef(definitionID, repositoryID, "ci"), nil
}

func (s *workflowsCovRouteService) ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if s.listWorkflowRunsByRepoFn != nil {
		return s.listWorkflowRunsByRepoFn(ctx, repositoryID, page, perPage)
	}
	return nil, nil
}

func (s *workflowsCovRouteService) ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error) {
	if s.listWorkflowRunsByDefinitionFn != nil {
		return s.listWorkflowRunsByDefinitionFn(ctx, repositoryID, definitionID, page, perPage)
	}
	return nil, nil
}

func (s *workflowsCovRouteService) GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	if s.getWorkflowRunFn != nil {
		return s.getWorkflowRunFn(ctx, repositoryID, runID)
	}
	return makeWFRun(runID, repositoryID, 1, "queued"), nil
}

func (s *workflowsCovRouteService) CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error {
	if s.cancelWorkflowRunFn != nil {
		return s.cancelWorkflowRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (s *workflowsCovRouteService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if s.resumeRunFn != nil {
		return s.resumeRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (s *workflowsCovRouteService) DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	if s.dispatchForEventFn != nil {
		return s.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}

func (s *workflowsCovRouteService) InvokeWorkflow(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
	return nil, nil
}

func (s *workflowsCovRouteService) RerunRun(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
	if s.rerunRunFn != nil {
		return s.rerunRunFn(ctx, input)
	}
	return &services.WorkflowRunResult{WorkflowRunID: input.RunID + 1, WorkflowDefinitionID: 1}, nil
}

func (s *workflowsCovRouteService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if s.listWorkflowStepsFn != nil {
		return s.listWorkflowStepsFn(ctx, runID)
	}
	return nil, nil
}

func (s *workflowsCovRouteService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if s.listWorkflowLogsSinceFn != nil {
		return s.listWorkflowLogsSinceFn(ctx, runID, afterID, limit)
	}
	return nil, nil
}

func (m *workflowsCovRouteService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
