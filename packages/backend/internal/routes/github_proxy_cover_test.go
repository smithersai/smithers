package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type githubProxyCovService struct {
	proxyRepoFn func(context.Context, *db.User, string, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error)
}

func (s githubProxyCovService) ProxyRepoRequest(ctx context.Context, actor *db.User, owner string, repo string, input services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
	return s.proxyRepoFn(ctx, actor, owner, repo, input)
}

func TestGithubProxy_Cov_PostRepoBodyAndResponseBranches(t *testing.T) {
	t.Parallel()

	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(context.Context, *db.User, string, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				t.Fatal("service should not be called")
				return nil, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github-proxy", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success filters restricted headers and defaults status", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(_ context.Context, _ *db.User, _ string, _ string, input services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				assert.Equal(t, "GET", input.Method)
				assert.Equal(t, "/rate_limit", input.Path)
				return &services.GitHubProxyResponse{
					Headers: http.Header{
						"Content-Type":   []string{"application/json"},
						"Set-Cookie":     []string{"secret=value"},
						"Content-Length": []string{"999"},
					},
					Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github-proxy", strings.NewReader(`{"method":"GET","path":"/rate_limit"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
		assert.Empty(t, rec.Header().Get("Set-Cookie"))
		assert.Empty(t, rec.Header().Get("Content-Length"))
		assert.JSONEq(t, `{"ok":true}`, rec.Body.String())
	})

	t.Run("nil response is internal error", func(t *testing.T) {
		t.Parallel()

		rec := httptest.NewRecorder()
		writeGitHubProxyResponse(rec, nil)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestGithubProxy_Cov_PostRepoBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github-proxy", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delegates to repo service", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(_ context.Context, actor *db.User, owner, repo string, input services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, json.RawMessage(`{"title":"change"}`), input.Body)
				return &services.GitHubProxyResponse{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader(`{"number":1}`))}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github-proxy", strings.NewReader(`{"method":"POST","path":"/repos/alice/demo/pulls","body":{"title":"change"}}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.JSONEq(t, `{"number":1}`, rec.Body.String())
	})

	t.Run("uses URL source coordinates instead of the resolved local mirror context", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(_ context.Context, _ *db.User, owner, repo string, _ services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				assert.Equal(t, "github-org", owner)
				assert.Equal(t, "upstream-repo", repo)
				return &services.GitHubProxyResponse{StatusCode: http.StatusNoContent}, nil
			},
		}}
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/repos/github-org/upstream-repo/github-proxy",
			strings.NewReader(`{"method":"GET","path":"/repos/github-org/upstream-repo"}`),
		)
		req = withRouteParams(req, map[string]string{"owner": "github-org", "repo": "upstream-repo"})
		req = withAuth(req, 7, "alice")
		ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
			Owner: "alice",
			Repository: &db.Repository{
				ID:        42,
				Name:      "upstream-repo-import-2",
				LowerName: "upstream-repo-import-2",
			},
		}, middleware.PermissionRead)
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		t.Parallel()

		h := &GitHubProxyHandler{Service: githubProxyCovService{
			proxyRepoFn: func(context.Context, *db.User, string, string, services.GitHubProxyRequest) (*services.GitHubProxyResponse, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github-proxy", strings.NewReader(`{"method":"GET","path":"/repos/alice/demo"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostRepoGitHubProxy(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}
