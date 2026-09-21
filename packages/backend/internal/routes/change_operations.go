package routes

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ListChangeOperations handles GET
// /api/repos/{owner}/{repo}/changes/{change_id}/operations[?rev=N].
func (h *JJVCSHandler) ListChangeOperations(w http.ResponseWriter, r *http.Request) {
	if h.ChangeOperations == nil {
		writeRouteError(w, r, pkgerrors.Internal("change operation service not configured"))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID := strings.TrimSpace(chi.URLParam(r, "change_id"))
	if changeID == "" {
		writeRouteError(w, r, pkgerrors.BadRequest("change id is required"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	var revision *int64
	if raw := strings.TrimSpace(r.URL.Query().Get("rev")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 1 {
			writeRouteError(w, r, pkgerrors.BadRequest("rev must be a positive integer"))
			return
		}
		revision = &value
	}
	operations, serviceErr := h.ChangeOperations.ListOperations(r.Context(), repository.ID, changeID, revision)
	if serviceErr != nil {
		writeRouteError(w, r, serviceErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, operations)
}

// PreviewOperationUndo handles GET
// /api/repos/{owner}/{repo}/workspaces/{id}/operations/{op_id}/undo/preview.
func (h *JJVCSHandler) PreviewOperationUndo(w http.ResponseWriter, r *http.Request) {
	user, repositoryID, _, _, workspaceID, operationID, err := h.operationUndoRouteContext(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	preview, serviceErr := h.ChangeOperations.PreviewUndo(r.Context(), repositoryID, user.ID, workspaceID, operationID)
	if serviceErr != nil {
		writeRouteError(w, r, serviceErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, preview)
}

// UndoOperation handles POST
// /api/repos/{owner}/{repo}/workspaces/{id}/operations/{op_id}/undo.
func (h *JJVCSHandler) UndoOperation(w http.ResponseWriter, r *http.Request) {
	user, repositoryID, owner, repoName, workspaceID, operationID, err := h.operationUndoRouteContext(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, serviceErr := h.ChangeOperations.Undo(r.Context(), repositoryID, user.ID, owner, repoName, workspaceID, operationID)
	if serviceErr != nil {
		writeRouteError(w, r, serviceErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *JJVCSHandler) operationUndoRouteContext(r *http.Request) (*db.User, int64, string, string, string, string, error) {
	if h.ChangeOperations == nil {
		return nil, 0, "", "", "", "", pkgerrors.Internal("change operation service not configured")
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		return nil, 0, "", "", "", "", pkgerrors.Unauthorized("authentication required")
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		return nil, 0, "", "", "", "", err
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		return nil, 0, "", "", "", "", apiErr
	}
	workspaceID := strings.TrimSpace(chi.URLParam(r, "id"))
	operationID := strings.TrimSpace(chi.URLParam(r, "op_id"))
	if workspaceID == "" || operationID == "" {
		return nil, 0, "", "", "", "", pkgerrors.BadRequest("workspace id and operation id are required")
	}
	return user, repository.ID, owner, repoName, workspaceID, operationID, nil
}
