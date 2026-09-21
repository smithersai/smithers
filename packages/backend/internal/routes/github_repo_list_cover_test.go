package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type githubRepoListCovService struct {
	result services.GitHubRepoListResult
	err    error
	userID int64
	query  url.Values
}

func (s *githubRepoListCovService) ListInstallationRepositories(ctx context.Context, userID int64, query url.Values) (services.GitHubRepoListResult, error) {
	s.userID = userID
	s.query = query
	if s.err != nil {
		return services.GitHubRepoListResult{}, s.err
	}
	return s.result, nil
}

func TestGitHubRepoList_Cov_ListGitHubReposBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		(&GitHubRepoListHandler{Service: &githubRepoListCovService{}}).ListGitHubRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/repos", nil))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("requires service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/github/repos", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitHubRepoListHandler{}).ListGitHubRepos(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "service unavailable")
	})

	t.Run("success sets link and writes array", func(t *testing.T) {
		svc := &githubRepoListCovService{result: services.GitHubRepoListResult{
			Repos: []services.GitHubRepoListItem{{FullName: "alice/demo", Name: "demo"}},
			Link:  `</api/github/repos?page=2>; rel="next"`,
		}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/github/repos?per_page=50", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitHubRepoListHandler{Service: svc}).ListGitHubRepos(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, int64(7), svc.userID)
		assert.Equal(t, "50", svc.query.Get("per_page"))
		assert.Equal(t, `</api/github/repos?page=2>; rel="next"`, rec.Header().Get("Link"))
		var body []services.GitHubRepoListItem
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body, 1)
		assert.Equal(t, "alice/demo", body[0].FullName)
	})

	t.Run("service error propagates", func(t *testing.T) {
		svc := &githubRepoListCovService{err: pkgerrors.BadRequest("bad github query")}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/github/repos", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitHubRepoListHandler{Service: svc}).ListGitHubRepos(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "bad github query")
	})
}
