package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// gitHubPushStub serves GET /repos/victimcorp/tool, a public repo: every
// linked user can read it, and only credentials in canPush may push.
func gitHubPushStub(t *testing.T) (setPush func(token string, push bool)) {
	t.Helper()
	var mu sync.Mutex
	canPush := map[string]bool{"Bearer gho_1": true}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/repos/victimcorp/tool" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			return
		}
		mu.Lock()
		push := canPush[r.Header.Get("Authorization")]
		mu.Unlock()
		if push {
			_, _ = w.Write([]byte(`{"id":5,"private":false,"permissions":{"pull":true,"push":true,"admin":false}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":5,"private":false,"permissions":{"pull":true,"push":false,"admin":false}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)
	return func(token string, push bool) {
		mu.Lock()
		defer mu.Unlock()
		canPush["Bearer "+token] = push
	}
}

type recordedMirrorFailures struct {
	mu     sync.Mutex
	labels []string
}

func (r *recordedMirrorFailures) ObserveMirrorFailure(stage, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.labels = append(r.labels, stage+"/"+reason)
}

func (r *recordedMirrorFailures) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.labels...)
}

func feedFor(t *testing.T, synced *GitHubSyncedRepoService, refsOnly bool) []GitHubSyncedRepoSummary {
	t.Helper()
	feed, err := synced.ListSyncedRepos(context.Background(), refsOnly)
	require.NoError(t, err)
	return feed
}

// TestGitHubMirror_OnlyAPusherCanPointGitHubSyncAtTheirRepo is the regression
// test for the cross-user write-back: every import re-pointed the registry's
// mirror at the latest importer's repo, and github-sync then pushed that repo's
// refs (with prune), issues, landings and merges to the GitHub repo with the
// platform token. A reader of a public repo could write to it.
func TestGitHubMirror_OnlyAPusherCanPointGitHubSyncAtTheirRepo(t *testing.T) {
	setPush := gitHubPushStub(t)
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	failures := &recordedMirrorFailures{}
	synced.SetMirrorFailureObserver(failures)
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	users := NewGitHubUserReposService(pushGateGitHubDB{newFakeGitHubUserReposDB()}, pushGateDecrypter{})
	users.now = func() time.Time { return now }
	synced.SetPushAccess(users)
	importer := &GitHubImportService{syncedRepos: synced}
	ctx := context.Background()

	const maintainer, reader, unlinked int64 = 1, 2, 3

	// importRepo is what a finished import does: its import_jobs row turns
	// ready, then the source is enrolled with the new mirror.
	importRepo := func(userID int64, namespace string) {
		store.recordReadyImport(fakeReadyImport{userID: userID, githubOwner: "victimcorp", githubRepo: "tool", repoOwner: namespace, repoName: "tool"})
		importer.EnrollImportedGitHubRepo(ctx, userID, "victimcorp", "tool", namespace, "tool")
	}

	// The maintainer can push: their import binds the mirror.
	importRepo(maintainer, "maintainer")
	feed := feedFor(t, synced, true)
	require.Len(t, feed, 1)
	assert.Equal(t, "maintainer", feed[0].SmithersOwner)

	// A reader (and a user with no GitHub account) imports the same public
	// repo. Their copy must not become what github-sync pushes to GitHub.
	importRepo(reader, "reader")
	importRepo(unlinked, "unlinked")
	feed = feedFor(t, synced, true)
	require.Len(t, feed, 1)
	assert.Equal(t, "maintainer", feed[0].SmithersOwner, "a non-pusher's import must not re-point the mirror")
	assert.Equal(t, "tool", feed[0].SmithersRepo)
	row, err := store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: "victimcorp", RepoName: "tool"})
	require.NoError(t, err)
	assert.Equal(t, "maintainer", row.MirrorOwner.String)
	assert.Contains(t, failures.all(), "github_push_bind/push_required")
	assert.Contains(t, failures.all(), "github_push_bind/no_github_credential")

	// The binding user loses push access. Once the proof expires, github-sync
	// is no longer told where the mirror is, so it writes nothing.
	setPush("gho_1", false)
	now = now.Add(githubPushProofTTL + time.Second)
	assert.Empty(t, feedFor(t, synced, true), "a binder who lost push access must not keep writing through the platform token")
	full := feedFor(t, synced, false)
	require.Len(t, full, 1)
	assert.Empty(t, full[0].SmithersOwner)
	assert.Empty(t, full[0].SmithersRepo)
	assert.Equal(t, string(GitHubPushProofDenied), full[0].MirrorSuspended)
	assert.Contains(t, failures.all(), "github_push_feed/push_required")
}

// TestGitHubMirror_FeedFailsClosed: a mirror no ready import produced (so no
// binder can be named), or a deployment with no push checker, advertises
// nothing.
func TestGitHubMirror_FeedFailsClosed(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	ctx := context.Background()
	row, err := synced.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{Owner: "victimcorp", Repo: "tool"})
	require.NoError(t, err)
	// A mirror no ready import produced: no binder.
	require.NoError(t, store.SetGitHubSyncedRepoMirror(ctx, db.SetGitHubSyncedRepoMirrorParams{ID: row.ID, MirrorOwner: "someone", MirrorRepo: "tool"}))

	synced.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	assert.Empty(t, feedFor(t, synced, true), "a mirror with no recorded binder is not advertised")
	full := feedFor(t, synced, false)
	require.Len(t, full, 1)
	assert.Equal(t, string(GitHubPushProofNoBinder), full[0].MirrorSuspended)

	unwired := NewGitHubSyncedRepoService(store)
	err = unwired.BindMirror(ctx, 1, row, "someone", "tool")
	var proofErr *GitHubPushProofError
	require.ErrorAs(t, err, &proofErr)
	assert.Equal(t, GitHubPushProofUnwired, proofErr.Reason)
}

// pushGateGitHubDB gives user N the GitHub credential "gho_N"; user 3 has no
// linked GitHub account.
type pushGateGitHubDB struct {
	*fakeGitHubUserReposDB
}

func (f pushGateGitHubDB) ListUserOAuthAccounts(_ context.Context, userID int64) ([]db.OauthAccount, error) {
	if userID == 3 {
		return nil, nil
	}
	return []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte(fmt.Sprintf("gho_%d", userID))}}, nil
}

type pushGateDecrypter struct{}

func (pushGateDecrypter) DecryptOAuthAccessToken(ciphertext []byte) (string, error) {
	return string(ciphertext), nil
}
