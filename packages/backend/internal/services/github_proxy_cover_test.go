package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHubProxy_Cov_OptionsAndValidationErrors(t *testing.T) {
	client := &http.Client{}
	svc := NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{}, WithGitHubProxyHTTPClient(client), WithGitHubProxyHTTPClient(nil))
	assert.Same(t, client, svc.httpClient)

	_, err := (*GitHubProxyService)(nil).ProxyRequest(context.Background(), "bad", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = svc.ProxyRequest(context.Background(), "bad", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = svc.ProxyRepoRequest(context.Background(), nil, "owner", "repo", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 1}, " ", "repo", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestGitHubProxy_Cov_ProxyRequestResolutionErrors(t *testing.T) {
	setSandboxSecret(t)
	token, err := IssueSandboxToken(123)
	require.NoError(t, err)

	svc := NewGitHubProxyService(&fakeGitHubProxyStore{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRequest(context.Background(), token, GitHubProxyRequest{Method: "GET", Path: "/repos/a/b/issues"})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewGitHubProxyService(&fakeGitHubProxyStore{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 123, RepositoryID: 7}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRequest(context.Background(), token, GitHubProxyRequest{Method: "GET", Path: "/repos/a/b/issues"})
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = NewGitHubProxyService(&fakeGitHubProxyStore{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 123, RepositoryID: 7}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, Name: "demo"}, nil
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRequest(context.Background(), token, GitHubProxyRequest{Method: "GET", Path: "/repos/a/b/issues"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGitHubProxy_Cov_NormalizeBodyPathAuditAndStatusCategories(t *testing.T) {
	assert.Equal(t, 500, statusCodeFromError(errors.New("plain")))
	assert.Equal(t, "auth", gitHubProxyFailureCategory(http.StatusUnauthorized, "deny"))
	assert.Equal(t, "permission", gitHubProxyFailureCategory(http.StatusForbidden, "deny"))
	assert.Equal(t, "not_found", gitHubProxyFailureCategory(http.StatusNotFound, "deny"))
	assert.Equal(t, "rate_limit", gitHubProxyFailureCategory(http.StatusTooManyRequests, "deny"))
	assert.Equal(t, "upstream", gitHubProxyFailureCategory(http.StatusBadGateway, "deny"))
	assert.Equal(t, "request", gitHubProxyFailureCategory(http.StatusBadRequest, "deny"))
	assert.Equal(t, "unknown", gitHubProxyFailureCategory(0, "deny"))
	assert.Empty(t, gitHubProxyFailureCategory(http.StatusOK, "allow"))

	method, path, err := normalizeGitHubProxyMethodAndPath(" get ", "/repos/acme/demo/issues?per_page=1")
	require.NoError(t, err)
	assert.Equal(t, http.MethodGet, method)
	assert.Equal(t, "/repos/acme/demo/issues?per_page=1", path)

	_, _, err = normalizeGitHubProxyMethodAndPath("TRACE", "/repos/acme/demo")
	require.Error(t, err)
	assert.Equal(t, 400, statusCodeFromError(err))

	body, hasBody, err := normalizeGitHubProxyBody(json.RawMessage(` null `))
	require.NoError(t, err)
	assert.False(t, hasBody)
	assert.Nil(t, body)

	_, _, err = normalizeGitHubProxyBody(json.RawMessage(`{"bad"`))
	require.Error(t, err)
	assert.Equal(t, 400, statusCodeFromError(err))

	store := &fakeGitHubProxyStore{}
	svc := NewGitHubProxyService(store, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.proxyRequest(context.Background(), gitHubProxyResolvedContext{
		ActorUserID:             1,
		Owner:                   "acme",
		Repo:                    "demo",
		AuditWorkflowRunID:      55,
		AuditWorkflowRunIDValid: true,
	}, GitHubProxyRequest{Method: "TRACE", Path: "/repos/acme/demo"}, GitHubProxyPolicyInput{})
	require.Error(t, err)
	require.Len(t, store.auditRows, 1)
	assert.Equal(t, int32(http.StatusBadRequest), store.auditRows[0].StatusCode)
	assert.Equal(t, "deny", store.auditRows[0].Decision)
}

func TestGitHubProxy_Cov_BuildUpstreamDefaultsAndIssuerFailure(t *testing.T) {
	svc := NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{})
	req, err := svc.buildUpstreamRequest(context.Background(), http.MethodPost, "/repos/acme/demo/issues", map[string]string{
		"Accept":        " ",
		"Authorization": "Bearer user",
		"X-Custom":      " value ",
	}, []byte(`{"title":"x"}`), true, " install ")
	require.NoError(t, err)
	assert.Equal(t, "Bearer install", req.Header.Get("Authorization"))
	assert.Equal(t, "application/vnd.github+json", req.Header.Get("Accept"))
	assert.Equal(t, "smithers-server", req.Header.Get("User-Agent"))
	assert.Equal(t, "application/json", req.Header.Get("Content-Type"))
	assert.Equal(t, "value", req.Header.Get("X-Custom"))
	assert.Empty(t, req.Header.Values("Authorization")[1:])
	body, err := io.ReadAll(req.Body)
	require.NoError(t, err)
	assert.JSONEq(t, `{"title":"x"}`, string(body))

	store := &fakeGitHubProxyStore{}
	svc = NewGitHubProxyService(store, &fakeGitHubProxyTokenIssuer{
		createFn: func(context.Context, int64, string, string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{}, &pkgerrors.APIError{Status: http.StatusForbidden, Message: "denied"}
		},
	})
	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 5}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestGitHubProxy_Cov_ProxyRepoRequestUsesCustomHTTPClient(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/repos/acme/demo/issues", r.URL.Path)
		assert.Equal(t, "Bearer install", r.Header.Get("Authorization"))
		w.Header().Set("X-Cov", "yes")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	svc := NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{
		createFn: func(context.Context, int64, string, string) (GitHubInstallationToken, error) {
			return GitHubInstallationToken{InstallationID: 9, Token: "install"}, nil
		},
	}, WithGitHubProxyHTTPClient(upstream.Client()))
	resp, err := svc.ProxyRepoRequest(context.Background(), &db.User{ID: 5}, "acme", "demo", GitHubProxyRequest{Method: "GET", Path: "/repos/acme/demo/issues"})
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "yes", resp.Headers.Get("X-Cov"))
}

func TestGitHubProxy_Cov_ResolveRepositoryOwnerErrorBranches(t *testing.T) {
	svc := NewGitHubProxyService(&fakeGitHubProxyStore{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err := svc.resolveRepositoryOwner(context.Background(), db.Repository{UserID: pgtype.Int8{Int64: 1, Valid: true}})
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = NewGitHubProxyService(&fakeGitHubProxyStore{
		getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
			return db.Organization{}, errors.New("db down")
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.resolveRepositoryOwner(context.Background(), db.Repository{OrgID: pgtype.Int8{Int64: 2, Valid: true}})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
