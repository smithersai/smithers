package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminRepoRouteService is the service interface required by AdminRepoHandler.
type AdminRepoRouteService interface {
	ListAllRepos(ctx context.Context, input services.AdminRepoListInput) ([]services.AdminRepoResponse, int64, error)
}

// AdminRepoHandler handles admin-level repo listing endpoints.
type AdminRepoHandler struct {
	Service AdminRepoRouteService
}

// ListRepos handles GET /api/admin/repos.
func (h *AdminRepoHandler) ListRepos(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	repos, total, err := h.Service.ListAllRepos(r.Context(), services.AdminRepoListInput{
		Page:    page,
		PerPage: limit,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(repos), total)
	pkgerrors.WriteJSON(w, http.StatusOK, repos)
}
