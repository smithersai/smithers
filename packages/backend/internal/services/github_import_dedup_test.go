package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// dedupRepoDB is a name-aware repoDB fake: lookups hit only the repos in
// `existing` (keyed by lower name), and CreateRepo records what was created.
type dedupRepoDB struct {
	existing map[string]db.Repository
	created  *db.CreateRepoParams
}

func (d *dedupRepoDB) CreateRepo(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	if d.created != nil {
		*d.created = arg
	}
	return db.Repository{ID: 42, Name: arg.Name, LowerName: arg.LowerName, DefaultBookmark: arg.DefaultBookmark}, nil
}

func (d *dedupRepoDB) DeleteRepo(context.Context, int64) error { return nil }

func (d *dedupRepoDB) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if repo, ok := d.existing[arg.LowerName]; ok {
		return repo, nil
	}
	return db.Repository{}, pgx.ErrNoRows
}

// A same-name local repo that is NOT this source's mirror must no longer
// dead-end in the #47 409 — the mirror gets the source-owner-qualified name and
// every local repo-host/workspace op keys on that deduped name.
func TestGitHubImportService_RunImportDedupesMirrorNameOnCollision(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "trunk",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	var created db.CreateRepoParams
	repoDB := &dedupRepoDB{
		existing: map[string]db.Repository{
			// "demo" is taken by a repo that is NOT the mirror of octo/demo.
			"demo": {ID: 99, Name: "demo", LowerName: "demo", DefaultBookmark: "main"},
		},
		created: &created,
	}
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "trunk", TargetChangeID: "change-trunk"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   42,
			UserID:         7,
			TargetBookmark: "landing/demo",
			Status:         "running",
		},
	}
	var clonePushURL string
	svc := NewGitHubImportService(
		nil,
		repoDB,
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportCloneMirror(func(_ context.Context, _, _, _, pushURL, _, _ string) error {
			clonePushURL = pushURL
			return nil
		}),
	)

	repository, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "importer", "landing/demo", "job-dedup")
	require.NoError(t, err)
	assert.Equal(t, "demo-octo", repository.Name, "collision must dedup into the source-owner-qualified name")
	assert.Equal(t, "demo-octo", created.Name)
	assert.Equal(t, "demo-octo", repoHost.initRepoName)
	assert.Equal(t, "demo-octo", repoHost.importRefsRepo, "local refs import must target the deduped mirror, not the colliding repo")
	assert.Equal(t, "demo-octo", provisioner.input.RepoName, "workspace must bind to the deduped mirror")
	assert.Contains(t, clonePushURL, "demo-octo", "mirror push must target the deduped repo path")
}

// Re-importing a source whose mirror was previously deduped must REUSE that
// deduped mirror (provenance match on the candidate), never create a third
// name or 409.
func TestGitHubImportService_EnsureLocalRepoReusesDedupedMirror(t *testing.T) {
	repoDB := &dedupRepoDB{
		existing: map[string]db.Repository{
			"demo":      {ID: 99, Name: "demo", LowerName: "demo"},
			"demo-octo": {ID: 77, Name: "demo-octo", LowerName: "demo-octo"},
		},
	}
	svc := NewGitHubImportService(
		nil,
		repoDB,
		testGitHubImportTokenDB{},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{},
		"https://smithers.test",
		withGitHubImportProvenance(func(_ context.Context, _ int64, _, _ string, repositoryID int64) (bool, error) {
			return repositoryID == 77, nil
		}),
	)

	repository, reused, err := svc.ensureLocalRepo(context.Background(), 7, "importer", "octo", "demo", "trunk")
	require.NoError(t, err)
	assert.True(t, reused, "the previously-deduped mirror must be reused")
	assert.Equal(t, int64(77), repository.ID)
	assert.Equal(t, "demo-octo", repository.Name)
}

func TestMirrorNameCandidates(t *testing.T) {
	candidates := mirrorNameCandidates("demo", " OctoCat ")
	require.Len(t, candidates, 5)
	assert.Equal(t, []string{"demo", "demo-octocat", "demo-octocat-2", "demo-octocat-3"}, candidates[:4])
	assert.NoError(t, validateRepoName(candidates[4]))
	assert.LessOrEqual(t, len(candidates[4]), 100)
}

func TestMirrorNameCandidatesAlwaysHasValidHashedFallback(t *testing.T) {
	for _, repo := range []string{
		strings.Repeat("a", 96) + ".git",
		strings.Repeat("b", 100),
		"api",
	} {
		candidates := mirrorNameCandidates(repo, "very-long-source-owner")
		require.NotEmpty(t, candidates)
		fallback := candidates[len(candidates)-1]
		assert.NoError(t, validateRepoName(fallback), fallback)
		assert.LessOrEqual(t, len(fallback), 100)
	}
}

func TestDefinitiveProvisionConflictRequiresMachineCode(t *testing.T) {
	assert.True(t, isDefinitiveProvisionConflict(&repohost.StatusError{
		StatusCode: http.StatusConflict, Code: "destination_occupied", Message: "translated text",
	}))
	assert.False(t, isDefinitiveProvisionConflict(&repohost.StatusError{
		StatusCode: http.StatusConflict, Message: "destination repository already exists",
	}))
	assert.False(t, isDefinitiveProvisionConflict(&repohost.StatusError{
		StatusCode: http.StatusInternalServerError, Code: "destination_occupied",
	}))
}
