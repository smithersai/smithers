package routes

import (
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestWorkflowInspection_F_ListRunsV2Errors covers the two service-error guards
// in ListWorkflowRunsV2 (runs lookup and definition lookup).
func TestWorkflowInspection_F_ListRunsV2Errors(t *testing.T) {
	t.Run("runs lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			listWorkflowRunsByRepoFn: func(context.Context, int64, int, int) ([]db.WorkflowRun, error) {
				return nil, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()
		h.ListWorkflowRunsV2(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("definition lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			listWorkflowRunsByRepoFn: func(context.Context, int64, int, int) ([]db.WorkflowRun, error) {
				return []db.WorkflowRun{makeWFRun(7, 101, 3, "running")}, nil
			},
			listWorkflowDefinitionsFn: func(context.Context, int64, int, int) ([]db.WorkflowDefinition, error) {
				return nil, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs?state=running", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()
		h.ListWorkflowRunsV2(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// TestWorkflowInspection_F_GetRunV2Errors covers the non-APIError, no-repo, and
// downstream service errors flowing through buildWorkflowRunInspectionResponse.
func TestWorkflowInspection_F_GetRunV2Errors(t *testing.T) {
	newReq := func(withRepo bool) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/7", nil)
		if withRepo {
			req = withRepoContext(req, "alice", "demo")
		}
		return withRouteParams(req, map[string]string{"id": "7"})
	}

	t.Run("no repo context", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunV2(rec, newReq(false))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("run lookup plain error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunV2(rec, newReq(true))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("definition lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(context.Context, int64, int64) (db.WorkflowDefinition, error) {
				return db.WorkflowDefinition{}, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunV2(rec, newReq(true))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("steps lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				return makeWFDef(defID, repoID, "dev"), nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunV2(rec, newReq(true))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// TestWorkflowInspection_F_GetRunNodeBranches covers GetWorkflowRunNode's guards
// plus the log-filter success path.
func TestWorkflowInspection_F_GetRunNodeBranches(t *testing.T) {
	newReq := func(withRepo bool, params map[string]string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workflows/runs/7/nodes/compile", nil)
		if withRepo {
			req = withRepoContext(req, "alice", "demo")
		}
		return withRouteParams(req, params)
	}
	okParams := map[string]string{"id": "7", "nodeId": "compile"}

	t.Run("service unavailable", func(t *testing.T) {
		h := WorkflowHandler{}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid run id", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, map[string]string{"id": "0", "nodeId": "compile"}))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("run lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("definition lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(context.Context, int64, int64) (db.WorkflowDefinition, error) {
				return db.WorkflowDefinition{}, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("steps lookup error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				return makeWFDef(defID, repoID, "dev"), nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("logs error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				return makeWFDef(defID, repoID, "dev"), nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return []db.WorkflowStep{{ID: 11, Name: "compile", Position: 1, Status: "success"}}, nil
			},
			listWorkflowLogsSinceFn: func(context.Context, int64, int64, int32) ([]db.WorkflowLog, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("success filters foreign step logs", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
				return makeWFRun(runID, repoID, 3, "running"), nil
			},
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				return makeWFDef(defID, repoID, "dev"), nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return []db.WorkflowStep{
					{ID: 11, Name: "compile", Position: 1, Status: "success"},
					{ID: 12, Name: "test", Position: 2, Status: "running"},
				}, nil
			},
			listWorkflowLogsSinceFn: func(context.Context, int64, int64, int32) ([]db.WorkflowLog, error) {
				return []db.WorkflowLog{
					{ID: 1, WorkflowStepID: 11, Sequence: 0, Stream: "stdout", Entry: "mine"},
					{ID: 2, WorkflowStepID: 12, Sequence: 1, Stream: "stdout", Entry: "other"},
				}, nil
			},
		}}
		rec := httptest.NewRecorder()
		h.GetWorkflowRunNode(rec, newReq(true, okParams))
		require.Equal(t, http.StatusOK, rec.Code)
		require.Contains(t, rec.Body.String(), "mine")
		require.NotContains(t, rec.Body.String(), "other")
	})
}

// TestWorkflowInspection_F_DispatchBranches covers the remaining dispatch guards.
func TestWorkflowInspection_F_DispatchBranches(t *testing.T) {
	t.Run("service unavailable", func(t *testing.T) {
		h := WorkflowHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("no repo context", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"name": "44"})
		req = withAuth(req, 5, "alice")
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("empty identifier", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows//dispatch", strings.NewReader(`{}`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 5, "alice")
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("definition resolve error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			listWorkflowDefinitionsFn: func(context.Context, int64, int, int) ([]db.WorkflowDefinition, error) {
				return nil, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/missing/dispatch", strings.NewReader(`{}`))
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"name": "missing"})
		req = withAuth(req, 5, "alice")
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid dispatch inputs", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				def := makeWFDef(defID, repoID, "release")
				def.Config = []byte(`{"on":{"workflow_dispatch":{"inputs":{"issue":{"required":true}}}},"jobs":{}}`)
				return def, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{"inputs":{}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"name": "44"})
		req = withAuth(req, 5, "alice")
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.GreaterOrEqual(t, rec.Code, http.StatusBadRequest)
	})

	t.Run("dispatch service error", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{
			getWorkflowDefinitionFn: func(_ context.Context, repoID, defID int64) (db.WorkflowDefinition, error) {
				def := makeWFDef(defID, repoID, "release")
				def.Config = []byte(`{"on":{"workflow_dispatch":{"inputs":{"target":{"required":false,"default":"staging"}}}},"jobs":{}}`)
				return def, nil
			},
			dispatchForEventFn: func(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
				return nil, stderrors.New("dispatch failed")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/44/dispatch", strings.NewReader(`{"inputs":{}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"name": "44"})
		req = withAuth(req, 5, "alice")
		rec := httptest.NewRecorder()
		h.DispatchWorkflowByIdentifier(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// TestWorkflowInspection_F_ResumeBranches covers ResumeWorkflowRun guards.
func TestWorkflowInspection_F_ResumeBranches(t *testing.T) {
	t.Run("service unavailable", func(t *testing.T) {
		h := WorkflowHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/runs/7/resume", nil)
		rec := httptest.NewRecorder()
		h.ResumeWorkflowRun(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("no repo context", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/runs/7/resume", nil)
		req = withRouteParams(req, map[string]string{"id": "7"})
		rec := httptest.NewRecorder()
		h.ResumeWorkflowRun(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid run id", func(t *testing.T) {
		h := WorkflowHandler{Service: &mockWorkflowInspectionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workflows/runs/0/resume", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "0"})
		rec := httptest.NewRecorder()
		h.ResumeWorkflowRun(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

// TestWorkflowInspection_F_PureHelpers covers the sub-minute duration format,
// the unlabeled mermaid edge, and the XML must-helper panic path.
func TestWorkflowInspection_F_PureHelpers(t *testing.T) {
	started := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	completed := started.Add(30 * time.Second)
	seconds, label := formatWorkflowDuration(&started, &completed)
	require.Equal(t, int64(30), seconds)
	require.Equal(t, "30s", label)

	mermaid := buildWorkflowRunMermaid([]workflowRunNodeResponse{{Name: "a"}, {Name: "b"}})
	require.Contains(t, mermaid, "N1 --> N2")

	require.Panics(t, func() {
		mustMarshalWorkflowXML(map[string]string{"a": "b"})
	})
}
