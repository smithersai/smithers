package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type workflowRunsCovFlusher struct {
	flushed bool
}

func (f *workflowRunsCovFlusher) Flush() {
	f.flushed = true
}

func TestWorkflowRuns_Cov_StreamPreListenBranches(t *testing.T) {
	t.Parallel()

	t.Run("missing repo context", func(t *testing.T) {
		t.Parallel()

		h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
		req = withRouteParams(req, map[string]string{"id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.WorkflowRunLogsStream(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository context not loaded")
	})

	t.Run("list steps error", func(t *testing.T) {
		t.Parallel()

		h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{
			getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: 1, RepositoryID: 101}, nil
			},
			listWorkflowStepsFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
				return nil, pkgerrors.Internal("steps unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
		req = withRouteParams(req, map[string]string{"id": "1"})
		req = withRepoInContext(req, &db.Repository{ID: 101, Name: "repo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.WorkflowRunLogsStream(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		// #267: writeRouteError sanitizes 5xx bodies to the generic status
		// text; "steps unavailable" is logged server-side, not returned.
		assert.Contains(t, rec.Body.String(), "internal server error")
	})
}

func TestWorkflowRuns_Cov_ReplayWorkflowLogsCallback(t *testing.T) {
	t.Parallel()

	var gotRunID, gotAfterID int64
	var gotLimit int32
	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{
		listWorkflowLogsSinceFn: func(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
			gotRunID = runID
			gotAfterID = afterID
			gotLimit = limit
			return []db.WorkflowLog{{ID: 12, WorkflowStepID: 5, Sequence: 3, Entry: "hello"}}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/logs", nil)
	req.Header.Set("Last-Event-ID", "10")
	rec := httptest.NewRecorder()
	flusher := &workflowRunsCovFlusher{}

	h.replayWorkflowLogs(99)(rec, req, flusher)

	assert.Equal(t, int64(99), gotRunID)
	assert.Equal(t, int64(10), gotAfterID)
	assert.Equal(t, int32(1000), gotLimit)
	assert.True(t, flusher.flushed)
	assert.Contains(t, rec.Body.String(), "id: 12")
	assert.Contains(t, rec.Body.String(), `"content":"hello"`)

	invalidRec := httptest.NewRecorder()
	invalidReq := httptest.NewRequest(http.MethodGet, "/logs", nil)
	invalidReq.Header.Set("Last-Event-ID", "nope")
	h.replayWorkflowLogs(99)(invalidRec, invalidReq, &workflowRunsCovFlusher{})
	assert.Empty(t, invalidRec.Body.String())
}

func TestWorkflowRuns_Cov_ExtractLogIDEdges(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "42", extractLogID(`{"log_id":42,"content":"x"}`))
	assert.Empty(t, extractLogID(`{"log_id":0}`))
	assert.Empty(t, extractLogID(`not-json`))
	_, ok := normalizeWorkflowRunLogPayload(`{"log_id":42,"step":0,"line":1,"content":"missing step"}`)
	assert.False(t, ok)
}
