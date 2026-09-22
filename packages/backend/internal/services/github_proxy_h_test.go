package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitHubProxy_H_ResolutionAndServiceErrors(t *testing.T) {
	setSandboxSecret(t)
	token, err := IssueSandboxToken(501)
	require.NoError(t, err)

	svc := NewGitHubProxyService(&fakeGitHubProxyStore{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("run lookup failed")
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRequest(context.Background(), token, GitHubProxyRequest{Method: "GET", Path: "/repos/a/b/issues"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = NewGitHubProxyService(&fakeGitHubProxyStore{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 501, RepositoryID: 7}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo lookup failed")
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRequest(context.Background(), token, GitHubProxyRequest{Method: "GET", Path: "/repos/a/b/issues"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = (&GitHubProxyService{}).ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "a", "b", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{}).ProxyRepoRequest(context.Background(), &db.User{ID: -1}, "a", "b", GitHubProxyRequest{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
}

func TestGitHubProxy_H_ProxyRequestDenialsAndUpstreamFailures(t *testing.T) {
	store := &fakeGitHubProxyStore{}
	svc := NewGitHubProxyService(store, &fakeGitHubProxyTokenIssuer{})
	_, err := svc.proxyRequest(context.Background(), gitHubProxyResolvedContext{
		ActorUserID:             1,
		Owner:                   "acme",
		Repo:                    "demo",
		AuditWorkflowRunID:      77,
		AuditWorkflowRunIDValid: true,
	}, GitHubProxyRequest{Method: "POST", Path: "/repos/acme/demo/check-runs", Body: json.RawMessage(`{"bad"`)}, GitHubProxyPolicyInput{})
	require.Error(t, err)
	require.Len(t, store.auditRows, 1)
	assert.Equal(t, int32(http.StatusBadRequest), store.auditRows[0].StatusCode)

	store = &fakeGitHubProxyStore{}
	svc = NewGitHubProxyService(store, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.proxyRequest(context.Background(), gitHubProxyResolvedContext{
		ActorUserID: 1,
		Owner:       "acme",
		Repo:        "demo",
	}, GitHubProxyRequest{Method: "DELETE", Path: "/repos/acme/demo/git/refs/heads/main"}, GitHubProxyPolicyInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	svc = NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.github.test")
	svc = NewGitHubProxyService(&fakeGitHubProxyStore{}, &fakeGitHubProxyTokenIssuer{}, WithGitHubProxyHTTPClient(&http.Client{
		Transport: githubUserReposHRoundTrip(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("upstream dial failed")
		}),
	}))
	_, err = svc.ProxyRepoRequest(context.Background(), &db.User{ID: 1}, "acme", "demo", GitHubProxyRequest{
		Method: "GET",
		Path:   "/repos/acme/demo/issues",
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestGitHubProxy_H_OwnerAuditAndNormalizeBranches(t *testing.T) {
	svc := NewGitHubProxyService(&fakeGitHubProxyStore{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("user failed")
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err := svc.resolveRepositoryOwner(context.Background(), db.Repository{UserID: pgtype.Int8{Int64: 1, Valid: true}})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = NewGitHubProxyService(&fakeGitHubProxyStore{
		getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
			return db.Organization{}, pgx.ErrNoRows
		},
	}, &fakeGitHubProxyTokenIssuer{})
	_, err = svc.resolveRepositoryOwner(context.Background(), db.Repository{OrgID: pgtype.Int8{Int64: 2, Valid: true}})
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	store := &fakeGitHubProxyStore{
		insertGithubProxyAuditLogFn: func(context.Context, clusterdb.InsertGithubProxyAuditLogParams) error {
			return errors.New("audit insert failed")
		},
	}
	svc = NewGitHubProxyService(store, &fakeGitHubProxyTokenIssuer{})
	svc.insertAuditLog(context.Background(), 9, true, "GET", "/repos/a/b", http.StatusOK, "allow", "ok")
	require.Len(t, store.auditRows, 1)

	for _, raw := range []string{"", "https://api.github.com/repos/a/b", "://bad"} {
		_, _, err := normalizeGitHubProxyMethodAndPath("GET", raw)
		require.Error(t, err, raw)
		assert.Equal(t, http.StatusBadRequest, statusCodeFromError(err))
	}

	req, err := svc.buildUpstreamRequest(context.Background(), http.MethodGet, "/repos/a/b", map[string]string{
		"Host":       "evil",
		"Connection": "close",
		"X-Trace":    " keep ",
	}, nil, false, "tok")
	require.NoError(t, err)
	assert.Equal(t, "keep", req.Header.Get("X-Trace"))
	assert.Empty(t, req.Header.Get("Host"))
	assert.Empty(t, req.Header.Get("Connection"))
	assert.Empty(t, req.Header.Get("Content-Type"))
}
