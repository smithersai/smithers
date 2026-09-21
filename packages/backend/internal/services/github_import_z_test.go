package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type githubImportZDB struct{}

func (githubImportZDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return githubImportHRow{err: assert.AnError}
}

type githubImportZRoundTrip func(*http.Request) (*http.Response, error)

func (f githubImportZRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestGitHubImport_Z_LocalOwnerRunImportAndMetadataErrors(t *testing.T) {
	ctx := context.Background()

	_, err := (&GitHubImportService{db: githubImportZDB{}}).resolveLocalOwner(ctx, 7)
	require.ErrorIs(t, err, assert.AnError)

	api := githubImportHAPI(t, http.StatusOK, map[string]any{"private": false, "default_branch": "main"})
	svc := NewGitHubImportService(
		&githubImportHDB{username: "alice"},
		githubImportHRepoDB{},
		githubImportHTokenDB{},
		&githubImportHRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}},
		githubImportHDecrypter{},
		"://bad",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(githubImportHWorkspace{}),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }),
	)
	_, _, err = svc.runImport(ctx, 7, "octo", "demo", "alice", "main", "job")
	require.Error(t, err)

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.github.test")
	transportErr := errors.New("transport failed")
	svc = &GitHubImportService{
		tokenDB:    githubImportHTokenDB{},
		decrypter:  githubImportHDecrypter{},
		httpClient: &http.Client{Transport: githubImportZRoundTrip(func(*http.Request) (*http.Response, error) { return nil, transportErr })},
	}
	_, _, _, err = svc.githubCloneInfoForRepo(ctx, 7, "octo", "demo")
	require.Equal(t, 500, apiStatus(t, err))

	_, _, _, err = svc.fetchGitHubRepoMetadata(ctx, "", "octo", "demo")
	require.Equal(t, 500, apiStatus(t, err))
}

func TestGitHubImport_Z_RefreshRetryCloneTempAndRealGitFallback(t *testing.T) {
	ctx := context.Background()
	t.Setenv(envGitHubAppAPIBaseURL, "https://api.github.test")

	calls := 0
	svc := &GitHubImportService{
		tokenDB:   githubImportHTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("x")}}},
		decrypter: githubImportHDecrypter{token: "old-token"},
		refresher: &fakeGitHubTokenRefresher{newToken: "new-token"},
		httpClient: &http.Client{Transport: githubImportZRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				return &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody}, nil
			}
			return nil, errors.New("retry failed")
		})},
	}
	_, _, _, err := svc.githubCloneInfoForRepo(ctx, 7, "octo", "demo")
	require.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 2, calls)

	svc = &GitHubImportService{
		mkdirTemp: func(string, string) (string, error) { return "", errors.New("temp failed") },
	}
	err = svc.cloneAndPushMirror(ctx, "octo", "demo", "", "https://plue.test/alice/demo.git", "push-token", "job")
	require.ErrorContains(t, err, "create temp dir")

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	err = (&GitHubImportService{}).cloneAndPushMirror(canceled, "octo", "demo", "", "https://plue.test/alice/demo.git", "push-token", "job")
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "clone github repo"))
}
