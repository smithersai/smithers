package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestRepoContext_Cov_RepoOwnerAndNameBranches(t *testing.T) {
	t.Parallel()

	t.Run("repo context with blank owner falls back to route owner", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil), map[string]string{"owner": "alice"})
		ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
			Owner:      " ",
			Repository: &db.Repository{ID: 1, Name: "demo"},
		}, middleware.PermissionRead)
		req = req.WithContext(ctx)

		owner, repo, err := repoOwnerAndName(req)

		require.NoError(t, err)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
	})

	t.Run("repo context with blank repo name is internal error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
		ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
			Owner:      "alice",
			Repository: &db.Repository{ID: 1, Name: " "},
		}, middleware.PermissionRead)
		req = req.WithContext(ctx)

		owner, repo, err := repoOwnerAndName(req)

		requireAPIErrorWithMessage(t, err, http.StatusInternalServerError, "repository context missing repository name")
		assert.Empty(t, owner)
		assert.Empty(t, repo)
	})

	t.Run("missing route owner fails without repo context", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos//demo", nil), map[string]string{"owner": "", "repo": "demo"})

		owner, repo, err := repoOwnerAndName(req)

		requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "owner is required")
		assert.Empty(t, owner)
		assert.Empty(t, repo)
	})
}
