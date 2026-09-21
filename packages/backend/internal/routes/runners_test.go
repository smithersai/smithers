package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRunnerRouteService struct {
	registerFn          func(ctx context.Context, input services.RunnerRegisterInput) (services.RunnerRegisterResult, error)
	claimTaskFn         func(ctx context.Context, runnerID int64) (*services.RunnerAssignedTask, error)
	heartbeatFn         func(ctx context.Context, runnerID int64) error
	terminateFn         func(ctx context.Context, runnerID int64) error
	getTaskRuntimeEnvFn func(ctx context.Context, taskID int64) (map[string]string, error)
	streamEventsFn      func(ctx context.Context, input services.RunnerStreamEventsInput) error
	completeTaskFn      func(ctx context.Context, input services.RunnerCompleteTaskInput) error
}

func (m *mockRunnerRouteService) Register(ctx context.Context, input services.RunnerRegisterInput) (services.RunnerRegisterResult, error) {
	if m.registerFn != nil {
		return m.registerFn(ctx, input)
	}
	return services.RunnerRegisterResult{}, nil
}

func (m *mockRunnerRouteService) ClaimTask(ctx context.Context, runnerID int64) (*services.RunnerAssignedTask, error) {
	if m.claimTaskFn != nil {
		return m.claimTaskFn(ctx, runnerID)
	}
	return nil, nil
}

func (m *mockRunnerRouteService) Heartbeat(ctx context.Context, runnerID int64) error {
	if m.heartbeatFn != nil {
		return m.heartbeatFn(ctx, runnerID)
	}
	return nil
}

func (m *mockRunnerRouteService) Terminate(ctx context.Context, runnerID int64) error {
	if m.terminateFn != nil {
		return m.terminateFn(ctx, runnerID)
	}
	return nil
}

func (m *mockRunnerRouteService) GetTaskRuntimeEnvironment(ctx context.Context, taskID int64) (map[string]string, error) {
	if m.getTaskRuntimeEnvFn != nil {
		return m.getTaskRuntimeEnvFn(ctx, taskID)
	}
	return map[string]string{}, nil
}

func (m *mockRunnerRouteService) StreamEvents(ctx context.Context, input services.RunnerStreamEventsInput) error {
	if m.streamEventsFn != nil {
		return m.streamEventsFn(ctx, input)
	}
	return nil
}

func (m *mockRunnerRouteService) CompleteTask(ctx context.Context, input services.RunnerCompleteTaskInput) error {
	if m.completeTaskFn != nil {
		return m.completeTaskFn(ctx, input)
	}
	return nil
}

func TestRunnerHandler_Register(t *testing.T) {
	t.Parallel()

	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/register", strings.NewReader("{"))
		rec := httptest.NewRecorder()

		h.Register(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			registerFn: func(ctx context.Context, input services.RunnerRegisterInput) (services.RunnerRegisterResult, error) {
				assert.Equal(t, "runner-1", input.Name)
				assert.JSONEq(t, `{"region":"us-east-1"}`, string(input.Metadata))
				return services.RunnerRegisterResult{
					RunnerID: 41,
					Task: &services.RunnerAssignedTask{
						ID:            2001,
						WorkflowRunID: 99,
						Payload:       json.RawMessage(`{"kind":"agent"}`),
					},
				}, nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/runners/register", strings.NewReader(`{"name":"runner-1","metadata":{"region":"us-east-1"}}`))
		rec := httptest.NewRecorder()

		h.Register(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload services.RunnerRegisterResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(41), payload.RunnerID)
		require.NotNil(t, payload.Task)
		assert.Equal(t, int64(2001), payload.Task.ID)
	})
}

func TestRunnerHandler_StreamEvents(t *testing.T) {
	t.Parallel()

	t.Run("invalid task id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/abc/stream", strings.NewReader(`{"events":[]}`))
		req = withRouteParams(req, map[string]string{"task-id": "abc"})
		rec := httptest.NewRecorder()

		h.StreamEvents(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/22/stream", strings.NewReader("{"))
		req = withRouteParams(req, map[string]string{"task-id": "22"})
		rec := httptest.NewRecorder()

		h.StreamEvents(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("accepted", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			streamEventsFn: func(ctx context.Context, input services.RunnerStreamEventsInput) error {
				assert.Equal(t, int64(22), input.TaskID)
				require.Len(t, input.Events, 1)
				assert.Equal(t, "token", input.Events[0].Type)
				assert.JSONEq(t, `{"text":"hello"}`, string(input.Events[0].Data))
				return nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/22/stream", strings.NewReader(`{"events":[{"type":"token","data":{"text":"hello"}}]}`))
		req = withRouteParams(req, map[string]string{"task-id": "22"})
		rec := httptest.NewRecorder()

		h.StreamEvents(rec, req)

		assert.Equal(t, http.StatusAccepted, rec.Code)
	})
}

func TestRunnerHandler_ClaimTask(t *testing.T) {
	t.Parallel()

	t.Run("invalid runner id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/abc/claim", nil)
		req = withRouteParams(req, map[string]string{"id": "abc"})
		rec := httptest.NewRecorder()

		h.ClaimTask(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("no task available", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			claimTaskFn: func(ctx context.Context, runnerID int64) (*services.RunnerAssignedTask, error) {
				assert.Equal(t, int64(42), runnerID)
				return nil, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/42/claim", nil)
		req = withRouteParams(req, map[string]string{"id": "42"})
		rec := httptest.NewRecorder()

		h.ClaimTask(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			claimTaskFn: func(ctx context.Context, runnerID int64) (*services.RunnerAssignedTask, error) {
				assert.Equal(t, int64(7), runnerID)
				return &services.RunnerAssignedTask{
					ID:             9,
					WorkflowRunID:  10,
					RepositoryID:   11,
					WorkflowStepID: 12,
					Attempt:        3,
					Payload:        json.RawMessage(`{"job":"build"}`),
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/7/claim", nil)
		req = withRouteParams(req, map[string]string{"id": "7"})
		rec := httptest.NewRecorder()

		h.ClaimTask(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload services.RunnerAssignedTask
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(9), payload.ID)
		assert.Equal(t, int64(11), payload.RepositoryID)
		assert.Equal(t, int64(12), payload.WorkflowStepID)
		assert.Equal(t, int32(3), payload.Attempt)
	})
}

func TestRunnerHandler_Heartbeat(t *testing.T) {
	t.Parallel()

	t.Run("invalid runner id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/abc/heartbeat", nil)
		req = withRouteParams(req, map[string]string{"id": "abc"})
		rec := httptest.NewRecorder()

		h.Heartbeat(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			heartbeatFn: func(ctx context.Context, runnerID int64) error {
				assert.Equal(t, int64(21), runnerID)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/21/heartbeat", nil)
		req = withRouteParams(req, map[string]string{"id": "21"})
		rec := httptest.NewRecorder()

		h.Heartbeat(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestRunnerHandler_Terminate(t *testing.T) {
	t.Parallel()

	t.Run("invalid runner id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/abc/terminate", nil)
		req = withRouteParams(req, map[string]string{"id": "abc"})
		rec := httptest.NewRecorder()

		h.Terminate(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			terminateFn: func(ctx context.Context, runnerID int64) error {
				assert.Equal(t, int64(21), runnerID)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runners/21/terminate", nil)
		req = withRouteParams(req, map[string]string{"id": "21"})
		rec := httptest.NewRecorder()

		h.Terminate(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestRunnerHandler_GetTaskEnvironment(t *testing.T) {
	t.Parallel()

	t.Run("invalid task id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/internal/tasks/abc/env", nil)
		req = withRouteParams(req, map[string]string{"task-id": "abc"})
		rec := httptest.NewRecorder()

		h.GetTaskEnvironment(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			getTaskRuntimeEnvFn: func(ctx context.Context, taskID int64) (map[string]string, error) {
				assert.Equal(t, int64(44), taskID)
				return nil, pkgerrors.NotFound("task not found")
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/internal/tasks/44/env", nil)
		req = withRouteParams(req, map[string]string{"task-id": "44"})
		rec := httptest.NewRecorder()

		h.GetTaskEnvironment(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			getTaskRuntimeEnvFn: func(ctx context.Context, taskID int64) (map[string]string, error) {
				assert.Equal(t, int64(55), taskID)
				return map[string]string{
					"ANTHROPIC_AUTH_TOKEN": "smithers_secret_token",
					"SMITHERS_AGENT_TOKEN": "smithers_agent_0123456789abcdef0123456789abcdef01234567",
				}, nil
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/internal/tasks/55/env", nil)
		req = withRouteParams(req, map[string]string{"task-id": "55"})
		rec := httptest.NewRecorder()

		h.GetTaskEnvironment(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload taskEnvironmentResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, "smithers_secret_token", payload.Env["ANTHROPIC_AUTH_TOKEN"])
		assert.Equal(t, "smithers_agent_0123456789abcdef0123456789abcdef01234567", payload.Env["SMITHERS_AGENT_TOKEN"])
	})
}

func TestRunnerHandler_CompleteTask(t *testing.T) {
	t.Parallel()

	t.Run("invalid task id", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/abc/complete", strings.NewReader(`{"status":"done"}`))
		req = withRouteParams(req, map[string]string{"task-id": "abc"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			completeTaskFn: func(ctx context.Context, input services.RunnerCompleteTaskInput) error {
				assert.Equal(t, int64(23), input.TaskID)
				assert.Equal(t, "failed", input.Status)
				assert.Equal(t, "runner crashed", input.Error)
				return pkgerrors.NotFound("task not found")
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/23/complete", strings.NewReader(`{"status":"failed","error":"runner crashed"}`))
		req = withRouteParams(req, map[string]string{"task-id": "23"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("no content", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			completeTaskFn: func(ctx context.Context, input services.RunnerCompleteTaskInput) error {
				assert.Equal(t, int64(24), input.TaskID)
				assert.Equal(t, "done", input.Status)
				return nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/24/complete", strings.NewReader(`{"status":"done"}`))
		req = withRouteParams(req, map[string]string{"task-id": "24"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("forwards runner_id to service", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			completeTaskFn: func(ctx context.Context, input services.RunnerCompleteTaskInput) error {
				assert.Equal(t, int64(24), input.TaskID)
				assert.Equal(t, int64(42), input.RunnerID)
				assert.Equal(t, "done", input.Status)
				return nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/24/complete", strings.NewReader(`{"runner_id":42,"status":"done"}`))
		req = withRouteParams(req, map[string]string{"task-id": "24"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("forwards runner_id and error for failed status", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			completeTaskFn: func(ctx context.Context, input services.RunnerCompleteTaskInput) error {
				assert.Equal(t, int64(23), input.TaskID)
				assert.Equal(t, int64(77), input.RunnerID)
				assert.Equal(t, "failed", input.Status)
				assert.Equal(t, "runner crashed", input.Error)
				return pkgerrors.NotFound("task not found")
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/23/complete", strings.NewReader(`{"runner_id":77,"status":"failed","error":"runner crashed"}`))
		req = withRouteParams(req, map[string]string{"task-id": "23"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("missing runner_id surfaces bad request from service", func(t *testing.T) {
		t.Parallel()

		h := RunnerHandler{Service: &mockRunnerRouteService{
			completeTaskFn: func(ctx context.Context, input services.RunnerCompleteTaskInput) error {
				// Simulate real service validation: RunnerID == 0 → bad request
				if input.RunnerID <= 0 {
					return pkgerrors.BadRequest("runner id must be positive")
				}
				return nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/internal/tasks/24/complete", strings.NewReader(`{"status":"done"}`))
		req = withRouteParams(req, map[string]string{"task-id": "24"})
		rec := httptest.NewRecorder()

		h.CompleteTask(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
