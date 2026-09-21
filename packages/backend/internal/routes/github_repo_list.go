package routes

import (
	"context"
	"net/http"
	"net/url"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type GitHubRepoListRouteService interface {
	ListInstallationRepositories(ctx context.Context, userID int64, query url.Values) (services.GitHubRepoListResult, error)
}

type GitHubRepoListHandler struct {
	Service GitHubRepoListRouteService
}

func (h *GitHubRepoListHandler) ListGitHubRepos(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github repo list service unavailable"))
		return
	}
	result, svcErr := h.Service.ListInstallationRepositories(r.Context(), user.ID, r.URL.Query())
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if result.Link != "" {
		w.Header().Set("Link", result.Link)
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result.Repos)
}
