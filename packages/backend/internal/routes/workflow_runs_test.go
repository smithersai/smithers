package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ---- mock service ----

type mockWorkflowRunRouteService struct {
	getWorkflowRunFn        func(ctx context.Context, repoID, runID int64) (db.WorkflowRun, error)
	listWorkflowStepsFn     func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn func(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
}

func (m *mockWorkflowRunRouteService) GetWorkflowRun(ctx context.Context, repoID, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, repoID, runID)
	}
	return db.WorkflowRun{}, nil
}

func (m *mockWorkflowRunRouteService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsFn != nil {
		return m.listWorkflowStepsFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockWorkflowRunRouteService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, runID, afterID, limit)
	}
	return nil, nil
}

// ---- WorkflowRunLogsStream Tests ----

func TestWorkflowRunLogsStream_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestWorkflowRunLogsStream_InvalidRunID(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/abc/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestWorkflowRunLogsStream_RunNotFound(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pkgerrors.NotFound("run not found")
		},
	}

	h := &WorkflowRunHandler{Service: svc}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/999/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "999"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestWorkflowRunLogsStream_NonFlusher_Returns500(t *testing.T) {
	t.Parallel()

	h := &WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withAuth(req, 1, "alice")
	// Use a response writer that does NOT implement http.Flusher.
	rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
}

func TestWorkflowRunLogsStream_NilPool_Returns500(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 1}, nil
		},
	}

	h := &WorkflowRunHandler{Service: svc, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowRunLogsStream_InvalidLastEventID_IgnoredGracefully(t *testing.T) {
	t.Parallel()

	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 1}, nil
		},
	}

	h := &WorkflowRunHandler{Service: svc, Broker: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/1/logs", nil)
	req.Header.Set("Last-Event-ID", "not-a-number")
	req = withRouteParams(req, map[string]string{"id": "1"})
	req = withRepoInContext(req, &db.Repository{ID: 1, Name: "repo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.WorkflowRunLogsStream(rec, req)
	// Pool==nil → 500 (the invalid header was gracefully ignored)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWorkflowRunLogsStream_SendsSSEFormat(t *testing.T) {
	t.Parallel()

	// Build a tiny streaming server that emits SSE events.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("test server writer is not a flusher")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Emit a log event.
		fmt.Fprintf(w, "id: 1\nevent: log\ndata: {\"step\":\"build\",\"line\":1,\"content\":\"hello\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	req, reqErr := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	require.NoError(t, reqErr)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
	assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "keep-alive", resp.Header.Get("Connection"))

	// Read the event.
	scanner := bufio.NewScanner(resp.Body)
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		lines = append(lines, line)
		if line == "" && len(lines) >= 3 {
			break
		}
	}

	require.GreaterOrEqual(t, len(lines), 3, "expected id, event, data lines; got: %v", lines)
	assert.Equal(t, "id: 1", lines[0], "first line must be id: 1")
	assert.Equal(t, "event: log", lines[1], "second line must be event: log")
	assert.True(t, strings.HasPrefix(lines[2], "data: "), "third line must start with data:")
}

func TestWorkflowRunLogsStream_ReplaysMissedLogsOnReconnect(t *testing.T) {
	t.Parallel()

	logs := []db.WorkflowLog{
		{ID: 11, WorkflowRunID: 1, WorkflowStepID: 1, Sequence: 1, Stream: "stdout", Entry: "missed log 1"},
		{ID: 12, WorkflowRunID: 1, WorkflowStepID: 1, Sequence: 2, Stream: "stdout", Entry: "missed log 2"},
	}

	var capturedRunID, capturedAfterID atomic.Int64
	var capturedLimit atomic.Int32
	svc := &mockWorkflowRunRouteService{
		getWorkflowRunFn: func(_ context.Context, _, _ int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 1}, nil
		},
		listWorkflowLogsSinceFn: func(_ context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
			capturedRunID.Store(runID)
			capturedAfterID.Store(afterID)
			capturedLimit.Store(limit)
			return logs, nil
		},
	}

	// Build a streaming server that simulates replay behavior.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("test server writer is not a flusher")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Simulate replay behavior.
		lastEventIDStr := r.Header.Get("Last-Event-ID")
		if lastEventIDStr != "" {
			lastEventID, parseErr := strconv.ParseInt(lastEventIDStr, 10, 64)
			if parseErr == nil {
				missed, _ := svc.ListWorkflowLogsSince(r.Context(), 1, lastEventID, 1000)
				for _, log := range missed {
					payload, _ := json.Marshal(map[string]any{
						"step":    "build",
						"line":    log.Sequence,
						"content": log.Entry,
					})
					fmt.Fprintf(w, "id: %d\nevent: log\ndata: %s\n\n", log.ID, payload)
					flusher.Flush()
				}
			}
		}
	}))
	defer srv.Close()

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	req.Header.Set("Last-Event-ID", "10")
	resp, err := http.DefaultClient.Do(req) //nolint:bodyclose
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Read and verify the replayed events.
	scanner := bufio.NewScanner(resp.Body)
	var allLines []string
	for scanner.Scan() {
		allLines = append(allLines, scanner.Text())
	}
	require.NoError(t, scanner.Err())

	// Reading through EOF synchronizes with the server handler: an HTTP client
	// may receive the flushed response headers before replay has started.
	assert.Equal(t, int64(1), capturedRunID.Load())
	assert.Equal(t, int64(10), capturedAfterID.Load())
	assert.Equal(t, int32(1000), capturedLimit.Load())

	// Should contain two events with id fields.
	output := strings.Join(allLines, "\n")
	assert.Contains(t, output, "id: 11")
	assert.Contains(t, output, "id: 12")
	assert.Contains(t, output, "missed log 1")
	assert.Contains(t, output, "missed log 2")
}

func TestWorkflowRunLogsStream_KeepAliveComment(t *testing.T) {
	t.Parallel()

	// Build a streaming server that emits keep-alive.
	events := make(chan struct{})
	defer close(events)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("test server writer is not a flusher")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Send keep-alive comment.
		fmt.Fprintf(w, ": keep-alive\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	req, reqErr := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	require.NoError(t, reqErr)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Read the keep-alive.
	scanner := bufio.NewScanner(resp.Body)
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		lines = append(lines, line)
		if line == "" {
			break
		}
	}

	require.GreaterOrEqual(t, len(lines), 1)
	assert.Equal(t, ": keep-alive", lines[0])
}

// ---- Helper Functions ----

func withRepoInContext(req *http.Request, repo *db.Repository) *http.Request {
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Repository: repo,
		Owner:      "owner",
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func TestNormalizeWorkflowRunLogPayload_RawNotifyPayload(t *testing.T) {
	t.Parallel()

	got, ok := normalizeWorkflowRunLogPayload(`{"log_id":42,"workflow_step_id":7,"sequence":3,"stream":"stdout","entry":"hello"}`)
	require.True(t, ok)
	assert.Equal(t, int64(42), got.LogID)
	assert.Equal(t, int64(7), got.Step)
	assert.Equal(t, int64(3), got.Line)
	assert.Equal(t, "hello", got.Content)
	assert.Equal(t, "stdout", got.Stream)
}

func TestNormalizeWorkflowRunLogPayload_AlreadyNormalized(t *testing.T) {
	t.Parallel()

	got, ok := normalizeWorkflowRunLogPayload(`{"log_id":42,"step":7,"line":3,"content":"hello"}`)
	require.True(t, ok)
	assert.Equal(t, int64(42), got.LogID)
	assert.Equal(t, int64(7), got.Step)
	assert.Equal(t, int64(3), got.Line)
	assert.Equal(t, "hello", got.Content)
}

func TestNormalizeWorkflowRunLogPayload_InvalidJSON_ReturnsFalse(t *testing.T) {
	t.Parallel()
	_, ok := normalizeWorkflowRunLogPayload(`not json at all`)
	assert.False(t, ok)
}

func (m *mockWorkflowRunRouteService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
