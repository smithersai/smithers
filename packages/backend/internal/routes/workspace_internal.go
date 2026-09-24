package routes

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// WorkspaceInternalRouteService defines the service interface for internal workspace callbacks.
type WorkspaceInternalRouteService interface {
	UpdateWorkspacePodStatus(ctx context.Context, input services.UpdateWorkspacePodStatusInput) error
	UpdateWorkspaceHead(ctx context.Context, input services.UpdateWorkspaceHeadInput) error
}

// WorkspaceInternalHandler handles internal workspace callback endpoints.
// These are called by runner pods via agent tokens.
type WorkspaceInternalHandler struct {
	Service WorkspaceInternalRouteService
}

type postWorkspaceStatusRequest struct {
	Status string `json:"status"` // "running", "suspended", "stopped", "failed"
}

type postWorkspaceHeadRequest struct {
	ChangeID string `json:"change_id"`
	CommitID string `json:"commit_id"`
	Ahead    int32  `json:"ahead"`
	Behind   int32  `json:"behind"`
}

// PostWorkspaceStatus handles POST /internal/workspace/{id}/status.
// Pod reports workspace status (running/stopped/failed).
func (h *WorkspaceInternalHandler) PostWorkspaceStatus(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace service unavailable"))
		return
	}

	workspaceID := chi.URLParam(r, "id")
	if workspaceID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("workspace id is required"))
		return
	}

	var req postWorkspaceStatusRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Status == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("status is required"))
		return
	}

	if err := h.Service.UpdateWorkspacePodStatus(r.Context(), services.UpdateWorkspacePodStatusInput{
		WorkspaceID: workspaceID,
		Status:      req.Status,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

// PostWorkspaceHead records the working-copy revision and divergence computed
// by the guest immediately after jj snapshots the working copy.
func (h *WorkspaceInternalHandler) PostWorkspaceHead(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace service unavailable"))
		return
	}
	workspaceID := chi.URLParam(r, "id")
	if workspaceID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("workspace id is required"))
		return
	}
	var req postWorkspaceHeadRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if err := h.Service.UpdateWorkspaceHead(r.Context(), services.UpdateWorkspaceHeadInput{
		WorkspaceID: workspaceID,
		ChangeID:    req.ChangeID,
		CommitID:    req.CommitID,
		Ahead:       req.Ahead,
		Behind:      req.Behind,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// Ensure WorkspaceInternalHandler.Service satisfies the interface at compile time.
var _ WorkspaceInternalRouteService = (*services.WorkspaceService)(nil)
