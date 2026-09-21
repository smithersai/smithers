package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRepoListRow scans the (owner, repo) pair the first-installed-repo query returns.
type fakeRepoListRow struct {
	owner string
	repo  string
	err   error
}

func (r fakeRepoListRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = r.owner
	*(dest[1].(*string)) = r.repo
	return nil
}

// fakeRepoListConnectionsRow scans the caller's connected owner/repo keys.
type fakeRepoListConnectionsRow struct{ keys []string }

func (r fakeRepoListConnectionsRow) Scan(dest ...any) error {
	*(dest[0].(*[]string)) = r.keys
	return nil
}

type fakeRepoListDB struct {
	row fakeRepoListRow
	// connections overrides the connected-repo keys; when nil the fake
	// reports the first-installed repo itself as the only connection.
	connections []string
}

func (d fakeRepoListDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, "array_agg") {
		keys := d.connections
		if keys == nil {
			keys = []string{strings.ToLower(d.row.owner) + "/" + strings.ToLower(d.row.repo)}
		}
		return fakeRepoListConnectionsRow{keys: keys}
	}
	return d.row
}

type fakeRepoListTokenIssuer struct{ instID int64 }

func (f fakeRepoListTokenIssuer) CreateGitHubInstallationToken(_ context.Context, _ int64, _ string, _ string) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{InstallationID: f.instID, Token: "install-token"}, nil
}

// Regression: one repo_connections row must not expose every repository in the
// GitHub App installation — only the caller's connected repos may be returned.
func TestGitHubRepoListService_FiltersListingToConnectedRepos(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"repositories":[
			{"full_name":"acme/demo","name":"demo","owner":{"login":"acme"}},
			{"full_name":"acme/secret","name":"secret","owner":{"login":"acme"},"private":true},
			{"full_name":"acme/other","name":"other","owner":{"login":"acme"},"private":true}
		]}`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	svc := NewGitHubRepoListService(
		fakeRepoListDB{
			row:         fakeRepoListRow{owner: "acme", repo: "demo"},
			connections: []string{"acme/demo"},
		},
		fakeRepoListTokenIssuer{instID: 7001},
	)

	result, err := svc.ListInstallationRepositories(context.Background(), 42, url.Values{})
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, "acme/demo", result.Repos[0].FullName)
}

func TestGitHubRepoListService_EvictsCachedTokenOn401(t *testing.T) {
	const instID = int64(6601)
	storeCachedInstallationToken(instID, "ghs_cached", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(instID) })

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	svc := NewGitHubRepoListService(
		fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}},
		fakeRepoListTokenIssuer{instID: instID},
	)

	_, err := svc.ListInstallationRepositories(context.Background(), 42, url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, ok := getCachedInstallationToken(instID)
	assert.False(t, ok, "the cached installation token must be evicted on 401")
}

func TestGitHubRepoListService_PreservesCachedTokenOnGeneric403(t *testing.T) {
	const instID = int64(6601)
	storeCachedInstallationToken(instID, "ghs_cached", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(instID) })

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"secondary rate limit"}`))
	}))
	defer upstream.Close()
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)

	svc := NewGitHubRepoListService(
		fakeRepoListDB{row: fakeRepoListRow{owner: "acme", repo: "demo"}},
		fakeRepoListTokenIssuer{instID: instID},
	)

	_, err := svc.ListInstallationRepositories(context.Background(), 42, url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	assert.Contains(t, err.Error(), "secondary rate limit")
	_, ok := getCachedInstallationToken(instID)
	assert.True(t, ok, "the cached installation token must be preserved on generic 403")
}
