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
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWorkflows_Z_RunResponseNullableCompletedAt(t *testing.T) {
	completed := time.Unix(123, 0).UTC()
	run := makeWFRun(5, 101, 9, "completed")
	run.CompletedAt = pgtype.Timestamptz{Time: completed, Valid: true}

	resp := toWorkflowRunResponse(run)

	require.NotNil(t, resp.CompletedAt)
	require.Equal(t, completed, *resp.CompletedAt)
}

// A superseded run must be distinguishable from an operator cancel in the API
// response, so a UI can render "Superseded by run 11763".
func TestWorkflows_Z_RunResponseCarriesCancelReason(t *testing.T) {
	run := makeWFRun(11753, 101, 9, "cancelled")
	run.CancelReason = "superseded_by_run:11763"

	resp := toWorkflowRunResponse(run)

	require.Equal(t, "superseded_by_run:11763", resp.CancelReason)

	body, err := json.Marshal(resp)
	require.NoError(t, err)
	require.Contains(t, string(body), `"cancel_reason":"superseded_by_run:11763"`)

	require.Empty(t, toWorkflowRunResponse(makeWFRun(11754, 101, 9, "cancelled")).CancelReason)
}

func TestWorkflows_Z_MissingRepoContextBranches(t *testing.T) {
	handler := WorkflowHandler{Service: &workflowsCovRouteService{}}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
	}{
		{"get workflow", handler.GetWorkflow, "", false},
		{"list workflow runs", handler.ListWorkflowRuns, "", false},
		{"list all workflow runs", handler.ListAllWorkflowRuns, "", false},
		{"get workflow run", handler.GetWorkflowRun, "", false},
		{"cancel workflow run", handler.CancelWorkflowRun, "", false},
		{"rerun workflow run", handler.RerunWorkflowRun, `{}`, true},
		{"dispatch workflow", handler.DispatchWorkflow, `{"ref":"main"}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/workflows/7", strings.NewReader(tc.body))
			req = withRouteParams(req, map[string]string{"id": "7"})
			if tc.auth {
				req = withAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusInternalServerError, rec.Code)
		})
	}
}

func TestWorkflows_Z_ListAndDispatchErrorBranches(t *testing.T) {
	nilServiceHandler := WorkflowHandler{}
	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/actions/runs", nil)
	req = withRepoContext(req, "alice", "demo")
	rec := httptest.NewRecorder()
	nilServiceHandler.ListAllWorkflowRuns(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	handler := WorkflowHandler{Service: &workflowsCovRouteService{}}
	req = httptest.NewRequest(http.MethodGet, "/repos/alice/demo/workflows/7/runs?page=0", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	rec = httptest.NewRecorder()
	handler.ListWorkflowRuns(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	handler = WorkflowHandler{Service: &workflowsCovRouteService{
		getWorkflowDefinitionFn: func(context.Context, int64, int64) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pkgerrors.NotFound("workflow definition not found")
		},
	}}
	req = httptest.NewRequest(http.MethodPost, "/repos/alice/demo/workflows/7/dispatches", strings.NewReader(`{"ref":"main"}`))
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "7"})
	req = withAuth(req, 1, "alice")
	rec = httptest.NewRecorder()
	handler.DispatchWorkflow(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
