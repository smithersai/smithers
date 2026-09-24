package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type workspaceCodingService interface {
	ReadCodingRevisions(context.Context, string, int64, int64, []string) (services.WorkspaceCodingResult, error)
	ApplyCodingOperation(context.Context, string, int64, int64, services.WorkspaceCodingInput) (services.WorkspaceCodingResult, error)
}

// ReadCodingRevisions handles GET /api/repos/{owner}/{repo}/workspaces/{id}/coding/revisions.
func (h *WorkspaceHandler) ReadCodingRevisions(w http.ResponseWriter, r *http.Request) {
	user, repo, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	service, ok := h.Service.(workspaceCodingService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace coding unavailable"))
		return
	}
	result, callErr := service.ReadCodingRevisions(r.Context(), workspaceID, repo.Repository.ID, user.ID, r.URL.Query()["change_id"])
	if callErr != nil {
		writeRouteError(w, r, callErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

// ApplyCodingOperation handles POST /api/repos/{owner}/{repo}/workspaces/{id}/coding/operations.
func (h *WorkspaceHandler) ApplyCodingOperation(w http.ResponseWriter, r *http.Request) {
	user, repo, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	service, ok := h.Service.(workspaceCodingService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace coding unavailable"))
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	var input services.WorkspaceCodingInput
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid coding operation JSON"))
		return
	}
	result, callErr := service.ApplyCodingOperation(r.Context(), workspaceID, repo.Repository.ID, user.ID, input)
	if callErr != nil {
		writeRouteError(w, r, callErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
