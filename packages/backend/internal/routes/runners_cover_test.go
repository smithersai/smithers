package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"

	"github.com/stretchr/testify/assert"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestRunners_Cov_ServiceUnavailableBranches(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		req    *http.Request
		invoke func(*RunnerHandler, http.ResponseWriter, *http.Request)
	}{
		{
			name: "register",
			req:  httptest.NewRequest(http.MethodPost, "/internal/runners/register", strings.NewReader(`{"name":"runner"}`)),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.Register(w, r)
			},
		},
		{
			name: "claim",
			req:  withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/runners/1/claim", nil), map[string]string{"id": "1"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.ClaimTask(w, r)
			},
		},
		{
			name: "heartbeat",
			req:  withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/runners/1/heartbeat", nil), map[string]string{"id": "1"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.Heartbeat(w, r)
			},
		},
		{
			name: "terminate",
			req:  withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/runners/1/terminate", nil), map[string]string{"id": "1"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.Terminate(w, r)
			},
		},
		{
			name: "stream",
			req:  withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/tasks/2/stream", strings.NewReader(`{"events":[]}`)), map[string]string{"task-id": "2"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.StreamEvents(w, r)
			},
		},
		{
			name: "env",
			req:  withRouteParams(httptest.NewRequest(http.MethodGet, "/internal/tasks/2/env", nil), map[string]string{"task-id": "2"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.GetTaskEnvironment(w, r)
			},
		},
		{
			name: "complete",
			req:  withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/tasks/2/complete", strings.NewReader(`{"runner_id":1,"status":"done"}`)), map[string]string{"task-id": "2"}),
			invoke: func(h *RunnerHandler, w http.ResponseWriter, r *http.Request) {
				h.CompleteTask(w, r)
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			handler := &RunnerHandler{}
			rec := httptest.NewRecorder()
			tt.invoke(handler, rec, tt.req)

			assert.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.Contains(t, rec.Body.String(), "runner service unavailable")
		})
	}
}

func TestRunners_Cov_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("register propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{
			registerFn: func(ctx context.Context, input clusterservices.RunnerRegisterInput) (clusterservices.RunnerRegisterResult, error) {
				assert.Equal(t, "runner-err", input.Name)
				return clusterservices.RunnerRegisterResult{}, pkgerrors.Forbidden("runner rejected")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/register", strings.NewReader(`{"name":"runner-err"}`))
		rec := httptest.NewRecorder()
		handler.Register(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("claim propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{
			claimTaskFn: func(ctx context.Context, runnerID int64) (*clusterservices.RunnerAssignedTask, error) {
				assert.Equal(t, int64(8), runnerID)
				return nil, pkgerrors.NotFound("runner not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/8/claim", nil)
		req = withRouteParams(req, map[string]string{"id": "8"})
		rec := httptest.NewRecorder()
		handler.ClaimTask(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("heartbeat propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{
			heartbeatFn: func(ctx context.Context, runnerID int64) error {
				assert.Equal(t, int64(9), runnerID)
				return pkgerrors.NotFound("runner not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/9/heartbeat", nil)
		req = withRouteParams(req, map[string]string{"id": "9"})
		rec := httptest.NewRecorder()
		handler.Heartbeat(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("terminate propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{
			terminateFn: func(ctx context.Context, runnerID int64) error {
				assert.Equal(t, int64(9), runnerID)
				return pkgerrors.Conflict("runner has active task")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/9/terminate", nil)
		req = withRouteParams(req, map[string]string{"id": "9"})
		rec := httptest.NewRecorder()
		handler.Terminate(rec, req)

		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("stream propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{
			streamEventsFn: func(ctx context.Context, input clusterservices.RunnerStreamEventsInput) error {
				assert.Equal(t, int64(12), input.TaskID)
				assert.Len(t, input.Events, 1)
				return pkgerrors.NotFound("task not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/12/stream", strings.NewReader(`{"events":[{"type":"log"}]}`))
		req = withRouteParams(req, map[string]string{"task-id": "12"})
		rec := httptest.NewRecorder()
		handler.StreamEvents(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("complete rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/12/complete", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"task-id": "12"})
		rec := httptest.NewRecorder()
		handler.CompleteTask(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("runner id must be positive", func(t *testing.T) {
		t.Parallel()
		handler := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/0/claim", nil)
		req = withRouteParams(req, map[string]string{"id": "0"})
		rec := httptest.NewRecorder()
		handler.ClaimTask(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid runner id")
	})
}
