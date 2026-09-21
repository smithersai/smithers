package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestRepoContext_H_EmptyContextOwnerRequiresRouteParam(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo", nil)
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Repository: &db.Repository{ID: 101, Name: "demo"},
	}, middleware.PermissionRead)

	_, _, err := repoOwnerAndName(req.WithContext(ctx))

	requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "owner is required")
}
