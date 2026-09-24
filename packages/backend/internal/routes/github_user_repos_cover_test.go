package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestGitHubUserRepos_Cov_ListBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires configured service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil), 42, "octo")
		rec := httptest.NewRecorder()

		(&GitHubUserReposHandler{}).ListGitHubUserRepos(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "service unavailable")
	})

	t.Run("service error propagates", func(t *testing.T) {
		h := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{err: pkgerrors.Unauthorized("github account not connected")}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil), 42, "octo")
		rec := httptest.NewRecorder()

		h.ListGitHubUserRepos(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Contains(t, rec.Body.String(), "github account not connected")
	})

	t.Run("success writes cache staleness headers", func(t *testing.T) {
		syncedAt := time.Date(2026, 7, 7, 15, 0, 0, 0, time.FixedZone("EDT", -4*60*60))
		h := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{result: services.GitHubRepoListResult{
			Repos:          []services.GitHubRepoListItem{{FullName: "octo/demo"}},
			Link:           `</api/user/github-repos?page=2>; rel="next"`,
			CacheSyncedAt:  &syncedAt,
			CacheSyncError: "stale cache",
		}}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil), 42, "octo")
		rec := httptest.NewRecorder()

		h.ListGitHubUserRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "2026-07-07T19:00:00Z", rec.Header().Get("X-Repos-Synced-At"))
		assert.Equal(t, "stale cache", rec.Header().Get("X-Repos-Sync-Error"))
		assert.Equal(t, `</api/user/github-repos?page=2>; rel="next"`, rec.Header().Get("Link"))
		assert.Contains(t, rec.Body.String(), "octo/demo")
	})
}
