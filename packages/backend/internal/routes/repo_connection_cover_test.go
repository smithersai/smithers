package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestRepoConnection_Cov_RequestValidationBranches(t *testing.T) {
	t.Parallel()

	t.Run("connect service not configured", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repo-connection", strings.NewReader(`{"owner":"acme","repo":"demo"}`))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.ConnectRepo(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("connect invalid json", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repo-connection", strings.NewReader(`{`))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.ConnectRepo(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("disconnect service error", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{
			disconnectFn: func(context.Context, int64, string, string) (bool, error) {
				return false, pkgerrors.NotFound("connection not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repo-connection", strings.NewReader(`{"owner":" acme ","repo":" demo "}`))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DisconnectRepo(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestRepoConnection_Cov_StatusValidationBranches(t *testing.T) {
	t.Parallel()

	t.Run("missing owner", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repo-connection?repo=demo", nil)
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.RepoConnectionStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "owner is required")
	})

	t.Run("missing repo", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repo-connection?owner=acme", nil)
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.RepoConnectionStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository name is required")
	})

	t.Run("github app route param error", func(t *testing.T) {
		t.Parallel()

		h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/acme//github-app-status", nil)
		req = withRouteParams(req, map[string]string{"owner": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.GitHubAppStatus(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestRepoConnection_Cov_GitHubStatusRateLimitFields(t *testing.T) {
	t.Parallel()

	const resetAt = "2026-09-02T13:00:00Z"
	h := &RepoHandler{RepoConnectionService: &mockRepoConnectionRouteService{
		githubAppStatusFn: func(context.Context, int64, string, string) (services.GitHubAppStatus, error) {
			return services.GitHubAppStatus{
				GitHubAppInstalled:       true,
				InstallationID:           99,
				InstallURL:               "https://github.test/install",
				Owner:                    "acme",
				Repo:                     "demo",
				GitHubRateLimitLimit:     5000,
				GitHubRateLimitRemaining: 4990,
				GitHubRateLimitReset:     resetAt,
			}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/demo/github-app-status", nil)
	req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.GitHubAppStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"github_rate_limit_limit":5000`)
	assert.Contains(t, rec.Body.String(), `"github_rate_limit_remaining":4990`)
	assert.Contains(t, rec.Body.String(), `"github_rate_limit_reset":"`+resetAt+`"`)
}
