package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A repo connection proves the importer could read the GitHub repo once. The
// GitHub App installation token it unlocks keeps reading the repo after the
// importer loses access (collaborator revoked, public repo made private, slug
// reused by a new private repo). Syncing new upstream commits into the
// importer's existing Smithers repo must therefore prove the importer's OWN
// credential still reads the repo, and must never delete what is already there.
func TestGitHubImportService_ReuseRefreshNeedsImportersCurrentReadAccess(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// The installation token still reads the private repo.
		_ = json.NewEncoder(w).Encode(map[string]any{"private": true, "default_branch": "main"})
	}))
	t.Cleanup(api.Close)
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	run := func(t *testing.T, opts ...GitHubImportOption) (*gitCallRecorder, *refreshSeamRepoHost, *[]int64, error) {
		t.Helper()
		deleted := &[]int64{}
		existing := db.Repository{ID: 99, Name: "secret", LowerName: "secret", DefaultBookmark: "main"}
		repoHost := &refreshSeamRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
		recorder := &gitCallRecorder{}
		svc := NewGitHubImportService(
			&stageRecordingDB{},
			testGitHubImportRepoDB{existing: &existing, deleted: deleted},
			testGitHubImportTokenDB{},
			repoHost,
			testGitHubImportDecrypter{},
			"https://smithers.test",
			append([]GitHubImportOption{
				WithGitHubImportHTTPClient(api.Client()),
				WithGitHubImportWorkspaceProvisioner(&testGitHubImportWorkspaceProvisioner{resp: WorkspaceResponse{
					ID: "11111111-1111-1111-1111-111111111111", RepositoryID: 99, UserID: 7, TargetBookmark: "main", Status: "running"}}),
				WithGitHubImportInstallationTokens(githubImportHInstallationTokens{token: "ghs_installation"}),
				withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) { return true, nil }),
			}, opts...)...,
		)
		svc.runGit = recorder.run
		svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }
		_, _, err := svc.runImport(context.Background(), 7, "acme", "secret", "importer", "main", "job-revoked")
		return recorder, repoHost, deleted, err
	}
	requireReconnect := func(t *testing.T, recorder *gitCallRecorder, repoHost *refreshSeamRepoHost, deleted *[]int64, err error) {
		t.Helper()
		var apiErr *pkgerrors.APIError
		require.True(t, errors.As(err, &apiErr), "want a typed API error, got %v", err)
		assert.Equal(t, pkgerrors.CodeGitHubReconnectRequired, apiErr.Code)
		assert.True(t, isTerminalGitHubImportFailure(err), "a lost grant must not be retried in the background")
		assert.Empty(t, recorder.calls, "no upstream commits may be fetched for an importer who lost access")
		assert.Empty(t, repoHost.importRefsOwner, "nothing may be imported into the existing repo")
		assert.Empty(t, *deleted, "the importer's existing repo must never be deleted")
	}

	t.Run("no read-access checker fails closed", func(t *testing.T) {
		recorder, repoHost, deleted, err := run(t)
		requireReconnect(t, recorder, repoHost, deleted, err)
	})

	t.Run("importer lost access", func(t *testing.T) {
		proofs := &repositoryJobGitHubReadStub{}
		recorder, repoHost, deleted, err := run(t, WithGitHubImportReadAccess(proofs))
		requireReconnect(t, recorder, repoHost, deleted, err)
		assert.Equal(t, []string{"7/acme/secret"}, proofs.asked, "the importer's own credential decides")
	})

	t.Run("importer still reads", func(t *testing.T) {
		proofs := &repositoryJobGitHubReadStub{allowed: map[string]bool{"7/acme/secret": true}}
		recorder, repoHost, _, err := run(t, WithGitHubImportReadAccess(proofs))
		require.NoError(t, err)
		require.NotNil(t, recorder.pushCall(), "a proven importer keeps receiving upstream commits")
		assert.Equal(t, "importer", repoHost.importRefsOwner)
	})
}
