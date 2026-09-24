package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestGithubProxy_H_RemainingBranches(t *testing.T) {
	t.Run("nil services", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/github-proxy", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		(&GitHubProxyHandler{}).PostGitHubProxy(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/repo/github-proxy", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		(&GitHubProxyHandler{}).PostRepoGitHubProxy(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("internal service error and repo invalid json", func(t *testing.T) {
		handler := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyFn: func(context.Context, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				return nil, pkgerrors.Forbidden("denied")
			},
			proxyRepoFn: func(context.Context, *db.User, string, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				t.Fatal("repo service should not be called")
				return nil, nil
			},
		}}

		req := httptest.NewRequest(http.MethodPost, "/github-proxy", strings.NewReader(`{"method":"GET","path":"/rate_limit"}`))
		req.Header.Set("Authorization", "Bearer sandbox-token")
		rec := httptest.NewRecorder()
		handler.PostGitHubProxy(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/repo/github-proxy", strings.NewReader(`{`))
		req = withAuth(req, 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.PostRepoGitHubProxy(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("repo owner route error", func(t *testing.T) {
		handler := &GitHubProxyHandler{Service: githubProxyCovService{}}
		req := httptest.NewRequest(http.MethodPost, "/repo/github-proxy", strings.NewReader(`{"method":"GET"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		handler.PostRepoGitHubProxy(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("nil response body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		writeGitHubProxyResponse(rec, &services.GitHubProxyResponse{StatusCode: http.StatusAccepted, Body: nil, Headers: http.Header{"X-Test": []string{"yes"}}})
		require.Equal(t, http.StatusAccepted, rec.Code)
		require.Equal(t, "yes", rec.Header().Get("X-Test"))
		require.Empty(t, rec.Body.String())

		resp := &services.GitHubProxyResponse{Body: io.NopCloser(strings.NewReader("ok"))}
		rec = httptest.NewRecorder()
		writeGitHubProxyResponse(rec, resp)
		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "ok", rec.Body.String())
	})
}
