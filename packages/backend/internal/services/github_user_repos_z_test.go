package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitHubUserRepos_Z_ListWarmAndLiveRefreshBranches(t *testing.T) {
	ctx := context.Background()

	upsertFail := githubUserReposHNewDB()
	upsertFail.upsertErr = assert.AnError
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(testRepoItems(1))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := NewGitHubUserReposService(upsertFail, githubUserReposHDecrypter{token: "tok"})
	result, err := svc.ListAuthenticatedUserGitHubRepos(ctx, 42, url.Values{})
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)

	done := make(chan error, 1)
	stale := githubUserReposHNewDB()
	stale.setRow(testRepoItems(1), time.Now().Add(-time.Hour))
	stale.row.SyncingSince = pgtype.Timestamptz{}
	svc = NewGitHubUserReposService(stale, githubUserReposHDecrypter{token: "tok"}, WithGitHubUserReposSyncNotify(func(_ int64, err error) {
		done <- err
	}))
	svc.WarmGitHubRepoListing(42)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("warm stale callback not called")
	}
	assert.Equal(t, 1, stale.claimCount())
	assert.GreaterOrEqual(t, stale.upsertCount(), 1)

	noAccount := githubUserReposHNewDB()
	noAccount.accounts = []db.OauthAccount{{Provider: "gitlab"}}
	svc = NewGitHubUserReposService(noAccount, githubUserReposHDecrypter{token: "tok"})
	_, err = svc.listLiveGitHubRepos(ctx, 42, url.Values{})
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	hits := 0
	refreshServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("Authorization") == "Bearer old" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		assert.Equal(t, "Bearer new", r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(testRepoItems(1))
	}))
	defer refreshServer.Close()
	t.Setenv(envGitHubAppAPIBaseURL, refreshServer.URL)

	refresher := &fakeGitHubTokenRefresher{newToken: "new"}
	svc = NewGitHubUserReposService(githubUserReposHNewDB(), githubUserReposHDecrypter{token: "old"}, WithGitHubUserReposTokenRefresher(refresher))
	result, err = svc.listLiveGitHubRepos(ctx, 42, mustParseQuery(t, "cursor=3&per_page=1"))
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	assert.Equal(t, 2, hits)
	assert.Equal(t, 1, refresher.callCount())
}
