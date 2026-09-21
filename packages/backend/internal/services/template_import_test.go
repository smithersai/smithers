package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type templateImportCaptureDB struct {
	createArgs []any
}

func (d *templateImportCaptureDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	switch sql {
	case `SELECT username FROM users WHERE id = $1`:
		return githubImportHRow{username: "alice"}
	case createImportJobSQL:
		d.createArgs = append([]any(nil), args...)
		return githubImportHRow{err: fmt.Errorf("stop after capture")}
	default:
		return githubImportHRow{err: fmt.Errorf("unexpected query")}
	}
}

func TestGitHubImportService_TemplateRegistryResolvesFixedSeeds(t *testing.T) {
	tests := []struct {
		templateID string
		owner      string
		repo       string
	}{
		{templateID: "vite-react", owner: "smithersai", repo: "template-vite-react"},
		{templateID: "ts-lib", owner: "smithersai", repo: "template-ts-lib"},
		{templateID: "incur-cli", owner: "smithersai", repo: "template-incur-cli"},
		{templateID: "smithers-product", owner: "smithersai", repo: "template-smithers-product"},
	}
	for _, tt := range tests {
		t.Run(tt.templateID, func(t *testing.T) {
			capture := &templateImportCaptureDB{}
			svc := NewGitHubImportService(capture, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test")

			_, err := svc.StartTemplateImport(context.Background(), ImportTemplateRepoInput{UserID: 7, TemplateID: tt.templateID, Name: "new-repo"})

			require.ErrorContains(t, err, "create import job")
			require.Len(t, capture.createArgs, 8)
			assert.Equal(t, tt.owner, capture.createArgs[2])
			assert.Equal(t, tt.repo, capture.createArgs[3])
			assert.Equal(t, "alice", capture.createArgs[4])
			assert.Equal(t, "new-repo", capture.createArgs[5])
			assert.Equal(t, "main", capture.createArgs[6])
		})
	}
}

func TestGitHubImportService_TemplateValidationAndCollision(t *testing.T) {
	svc := NewGitHubImportService(&githubImportHDB{username: "alice"}, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test")

	_, err := svc.StartTemplateImport(context.Background(), ImportTemplateRepoInput{UserID: 7, TemplateID: "missing", Name: "repo"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusNotFound, apiErr.Status)

	_, err = svc.StartTemplateImport(context.Background(), ImportTemplateRepoInput{UserID: 7, TemplateID: "vite-react", Name: "bad name"})
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)

	existing := db.Repository{ID: 42, Name: "taken", LowerName: "taken"}
	svc.repoDB = githubImportHRepoDB{existing: &existing}
	_, err = svc.StartTemplateImport(context.Background(), ImportTemplateRepoInput{UserID: 7, TemplateID: "vite-react", Name: "taken"})
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
}

func TestGitHubImportService_TemplateUsesRequestedLocalName(t *testing.T) {
	api := githubImportHAPI(t, http.StatusOK, map[string]any{"private": false, "default_branch": "main"})
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	workspace := &testGitHubImportWorkspaceProvisioner{resp: WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", TargetBookmark: "main"}}
	svc := NewGitHubImportService(
		&githubImportHDB{username: "alice"}, testGitHubImportRepoDB{}, testGitHubImportTokenDB{}, repoHost,
		testGitHubImportDecrypter{}, "https://plue.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(workspace),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }),
	)

	repository, _, err := svc.runImportToName(context.Background(), 7, "smithersai", "template-vite-react", "alice", "my-app", "main", "job-template")

	require.NoError(t, err)
	assert.Equal(t, "my-app", repository.Name)
	assert.Equal(t, "alice", repoHost.initRepoOwner)
	assert.Equal(t, "my-app", repoHost.initRepoName)
	assert.Equal(t, "my-app", repoHost.importRefsRepo)
	assert.Equal(t, "my-app", workspace.input.RepoName)
}
