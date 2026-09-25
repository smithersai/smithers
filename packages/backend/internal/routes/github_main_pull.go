package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type GitHubMainPullRouteService interface {
	Request(ctx context.Context, repositoryID int64) (services.GitHubMainPullStatus, error)
	Status(ctx context.Context, repositoryID int64) (services.GitHubMainPullStatus, error)
}

// GitHubMainPullHandler serves /api/repos/{owner}/{repo}/github/main-pull:
// POST requests a pull of GitHub's default branch now (also the retry), GET
// returns the receipt, including whether Smithers main equals GitHub's.
type GitHubMainPullHandler struct {
	Service GitHubMainPullRouteService
}

func (h *GitHubMainPullHandler) repository(w http.ResponseWriter, r *http.Request) (int64, bool) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github main pull is not configured"))
		return 0, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return 0, false
	}
	return repoCtx.Repository.ID, true
}

func (h *GitHubMainPullHandler) RequestMainPull(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	id, ok := h.repository(w, r)
	if !ok {
		return
	}
	status, err := h.Service.Request(r.Context(), id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, status)
}

func (h *GitHubMainPullHandler) GetMainPull(w http.ResponseWriter, r *http.Request) {
	id, ok := h.repository(w, r)
	if !ok {
		return
	}
	status, err := h.Service.Status(r.Context(), id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, status)
}
