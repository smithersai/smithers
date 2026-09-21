package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGithubUserRepos_H_GuardAndErrorBranches(t *testing.T) {
	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		(&GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{}}).ListGitHubUserRepos(rec, httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("requires service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil), 42, "octo")
		rec := httptest.NewRecorder()

		(&GitHubUserReposHandler{}).ListGitHubUserRepos(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil), 42, "octo")
		rec := httptest.NewRecorder()

		(&GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{err: pkgerrors.Forbidden("github denied")}}).ListGitHubUserRepos(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}
