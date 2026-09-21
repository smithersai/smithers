package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type RunnerRouteService interface {
	Register(ctx context.Context, input services.RunnerRegisterInput) (services.RunnerRegisterResult, error)
	ClaimTask(ctx context.Context, runnerID int64) (*services.RunnerAssignedTask, error)
	Heartbeat(ctx context.Context, runnerID int64) error
	Terminate(ctx context.Context, runnerID int64) error
	GetTaskRuntimeEnvironment(ctx context.Context, taskID int64) (map[string]string, error)
	StreamEvents(ctx context.Context, input services.RunnerStreamEventsInput) error
	CompleteTask(ctx context.Context, input services.RunnerCompleteTaskInput) error
}

type RunnerHandler struct {
	Service RunnerRouteService
}

type streamEventsRequest struct {
	Events []services.RunnerEvent `json:"events"`
}

type completeTaskRequest struct {
	RunnerID int64  `json:"runner_id"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

type taskEnvironmentResponse struct {
	Env map[string]string `json:"env"`
}

func (h *RunnerHandler) Register(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	var req services.RunnerRegisterInput
	if !decodeJSONBody(w, r, &req) {
		return
	}

	resp, err := h.Service.Register(r.Context(), req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

func (h *RunnerHandler) ClaimTask(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	runnerID, err := parseRunnerID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	task, err := h.Service.ClaimTask(r.Context(), runnerID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if task == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, task)
}

func (h *RunnerHandler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	runnerID, err := parseRunnerID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	if err := h.Service.Heartbeat(r.Context(), runnerID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *RunnerHandler) Terminate(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	runnerID, err := parseRunnerID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	if err := h.Service.Terminate(r.Context(), runnerID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *RunnerHandler) StreamEvents(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	taskID, err := parseTaskID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req streamEventsRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if err := h.Service.StreamEvents(r.Context(), services.RunnerStreamEventsInput{
		TaskID: taskID,
		Events: req.Events,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

func (h *RunnerHandler) GetTaskEnvironment(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	taskID, err := parseTaskID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	env, err := h.Service.GetTaskRuntimeEnvironment(r.Context(), taskID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, taskEnvironmentResponse{Env: env})
}

func (h *RunnerHandler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("runner service unavailable"))
		return
	}

	taskID, err := parseTaskID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req completeTaskRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if err := h.Service.CompleteTask(r.Context(), services.RunnerCompleteTaskInput{
		RunnerID: req.RunnerID,
		TaskID:   taskID,
		Status:   req.Status,
		Error:    req.Error,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func parseTaskID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "task-id")
	taskID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || taskID <= 0 {
		return 0, pkgerrors.BadRequest("invalid task id")
	}
	return taskID, nil
}

func parseRunnerID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "id")
	runnerID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || runnerID <= 0 {
		return 0, pkgerrors.BadRequest("invalid runner id")
	}
	return runnerID, nil
}
