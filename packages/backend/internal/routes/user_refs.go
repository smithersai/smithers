package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type UserRefRouteService interface {
	List(ctx context.Context, owner, repo string, userID int64) (repohost.UserRefList, error)
	Renew(ctx context.Context, owner, repo string, userID int64, name string) (repohost.UserRefInfo, error)
	StartFrom(ctx context.Context, owner, repo string, repositoryID, userID int64, workspaceID, name string) (services.UserRefSource, error)
}

// UserRefHandler serves the caller's own pushed refs (#1964, #1968):
//
//	GET  /api/repos/{owner}/{repo}/user-refs              refs with expiry and limits
//	POST /api/repos/{owner}/{repo}/user-refs/renew         {name} restarts one's expiry
//	POST /api/repos/{owner}/{repo}/workspaces/{id}/user-source {name?}
//	     pins one for a coding run in the caller's workspace: {name, base}
type UserRefHandler struct {
	Service UserRefRouteService
}

type userRefNameRequest struct {
	Name string `json:"name"`
}

func (h *UserRefHandler) scope(w http.ResponseWriter, r *http.Request) (*middleware.RepoContext, int64, bool) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return nil, 0, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if h == nil || h.Service == nil || repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return nil, 0, false
	}
	return repoCtx, user.ID, true
}

func (h *UserRefHandler) List(w http.ResponseWriter, r *http.Request) {
	repoCtx, userID, ok := h.scope(w, r)
	if !ok {
		return
	}
	list, err := h.Service.List(r.Context(), repoCtx.Owner, repoCtx.Repository.Name, userID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, list)
}

func (h *UserRefHandler) Renew(w http.ResponseWriter, r *http.Request) {
	repoCtx, userID, ok := h.scope(w, r)
	if !ok {
		return
	}
	var req userRefNameRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	info, err := h.Service.Renew(r.Context(), repoCtx.Owner, repoCtx.Repository.Name, userID, req.Name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, info)
}

func (h *UserRefHandler) StartFrom(w http.ResponseWriter, r *http.Request) {
	repoCtx, userID, ok := h.scope(w, r)
	if !ok {
		return
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	var req userRefNameRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	source, err := h.Service.StartFrom(r.Context(), repoCtx.Owner, repoCtx.Repository.Name, repoCtx.Repository.ID, userID, workspaceID, req.Name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, source)
}
