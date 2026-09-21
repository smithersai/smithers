package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type alertOutcomeTestRecorder struct {
	run     db.WorkflowRun
	claim   clusterservices.AlertRemediationTaskClaim
	outcome clusterservices.AlertRemediationOutcome
	err     error
	calls   int
}

func (r *alertOutcomeTestRecorder) RecordWorkflowRemediationOutcome(_ context.Context, run db.WorkflowRun, claim clusterservices.AlertRemediationTaskClaim, outcome clusterservices.AlertRemediationOutcome) error {
	r.calls++
	r.run = run
	r.claim = claim
	r.outcome = outcome
	return r.err
}

func alertOutcomeTestRequest(body, incidentID string, run *db.WorkflowRun, claims *middleware.RunnerTaskTokenClaims) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/internal/alerts/incidents/"+incidentID+"/outcome", strings.NewReader(body))
	req = withRouteParams(req, map[string]string{"incident-id": incidentID})
	ctx := req.Context()
	if run != nil {
		ctx = middleware.ContextWithWorkflowRun(ctx, run)
	}
	if claims != nil {
		ctx = middleware.ContextWithRunnerTaskToken(ctx, *claims)
	}
	return req.WithContext(ctx)
}

func TestAlertRemediationOutcomeHandler_RequiresExactTaskScopedRun(t *testing.T) {
	t.Parallel()
	run := db.WorkflowRun{ID: 22, RepositoryID: 33}

	for _, tc := range []struct {
		name   string
		run    *db.WorkflowRun
		claims *middleware.RunnerTaskTokenClaims
	}{
		{name: "legacy workflow token has no task claims", run: &run},
		{name: "shared runner token has no run or task claims"},
		{name: "run mismatch", run: &run, claims: &middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 23, RepositoryID: 33, RunnerID: 44, Attempt: 2}},
		{name: "repository mismatch", run: &run, claims: &middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 22, RepositoryID: 34, RunnerID: 44, Attempt: 2}},
		{name: "missing runner", run: &run, claims: &middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 22, RepositoryID: 33, Attempt: 2}},
		{name: "missing attempt", run: &run, claims: &middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 22, RepositoryID: 33, RunnerID: 44}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			recorder := &alertOutcomeTestRecorder{}
			h := &AlertRemediationOutcomeHandler{Recorder: recorder}
			rec := httptest.NewRecorder()
			h.Record(rec, alertOutcomeTestRequest(`{"state":"failed"}`, "inc-1", tc.run, tc.claims))
			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.Zero(t, recorder.calls)
		})
	}
}

func TestAlertRemediationOutcomeHandler_RecordsBoundPayload(t *testing.T) {
	t.Parallel()
	run := db.WorkflowRun{ID: 22, RepositoryID: 33}
	claims := middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 22, RepositoryID: 33, RunnerID: 44, Attempt: 2}
	recorder := &alertOutcomeTestRecorder{}
	h := &AlertRemediationOutcomeHandler{Recorder: recorder}
	rec := httptest.NewRecorder()

	h.Record(rec, alertOutcomeTestRequest(
		`{"state":"pr_opened","report_url":"https://github.com/smithers-ai/plue/pull/42"}`,
		"0.abcdef",
		&run,
		&claims,
	))

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, 1, recorder.calls)
	assert.Equal(t, run.ID, recorder.run.ID)
	assert.Equal(t, clusterservices.AlertRemediationTaskClaim{TaskID: 11, RunnerID: 44, Attempt: 2}, recorder.claim)
	assert.Equal(t, "0.abcdef", recorder.outcome.IncidentID)
	assert.Equal(t, "pr_opened", recorder.outcome.State)
	assert.Equal(t, "https://github.com/smithers-ai/plue/pull/42", recorder.outcome.ReportURL)
}

func TestAlertRemediationOutcomeHandler_ValidationAndRecorderErrors(t *testing.T) {
	t.Parallel()
	run := db.WorkflowRun{ID: 22, RepositoryID: 33}
	claims := middleware.RunnerTaskTokenClaims{TaskID: 11, WorkflowRunID: 22, RepositoryID: 33, RunnerID: 44, Attempt: 2}

	for _, tc := range []struct {
		name       string
		body       string
		incidentID string
		recorder   *alertOutcomeTestRecorder
		status     int
	}{
		{name: "missing incident id", body: `{"state":"failed"}`, recorder: &alertOutcomeTestRecorder{}, status: http.StatusBadRequest},
		{name: "receiver not configured", body: `{"state":"failed"}`, incidentID: "inc-1", status: http.StatusNotFound},
		{name: "invalid json", body: `{`, incidentID: "inc-1", recorder: &alertOutcomeTestRecorder{}, status: http.StatusBadRequest},
		{name: "unknown field", body: `{"state":"failed","incident_id":"forged"}`, incidentID: "inc-1", recorder: &alertOutcomeTestRecorder{}, status: http.StatusBadRequest},
		{name: "trailing json", body: `{"state":"failed"}{}`, incidentID: "inc-1", recorder: &alertOutcomeTestRecorder{}, status: http.StatusBadRequest},
		{name: "typed error", body: `{"state":"failed"}`, incidentID: "inc-1", recorder: &alertOutcomeTestRecorder{err: pkgerrors.Forbidden("wrong run")}, status: http.StatusForbidden},
		{name: "store error", body: `{"state":"failed"}`, incidentID: "inc-1", recorder: &alertOutcomeTestRecorder{err: errors.New("db unavailable")}, status: http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := &AlertRemediationOutcomeHandler{}
			if tc.recorder != nil {
				h.Recorder = tc.recorder
			}
			rec := httptest.NewRecorder()
			h.Record(rec, alertOutcomeTestRequest(tc.body, tc.incidentID, &run, &claims))
			assert.Equal(t, tc.status, rec.Code)
		})
	}
}
