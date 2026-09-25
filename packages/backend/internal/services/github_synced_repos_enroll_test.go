package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A renamed or transferred repository enrolled under its new slug with its
// known GitHub id resolves to its existing row and adopts the slug, keeping
// its metadata, instead of violating the unique github_repository_id index.
func TestEnrollGitHubRepoKnownIDAdoptsNewSlug(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	q := db.New(tx)
	svc := NewGitHubSyncedRepoService(q)

	oldName, newName := uuid.NewString(), uuid.NewString()
	const githubID = int64(987654321012)
	row, err := svc.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
		Owner: "octo", Repo: oldName, GitHubRepositoryID: githubID,
		EnrolledVia: GitHubSyncedRepoEnrolledViaImport, MetadataOnly: true,
	})
	require.NoError(t, err)
	require.NoError(t, q.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{
		SyncedRepoID: row.ID, Resource: "issues", Number: 7, GithubID: 107,
		State: "open", Title: "follows the rename", Payload: json.RawMessage(`{"number":7}`),
	}))

	renamed, err := svc.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
		Owner: "new-owner", Repo: newName, InstallationID: 42, GitHubRepositoryID: githubID,
		EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation,
	})
	require.NoError(t, err)
	assert.Equal(t, row.ID, renamed.ID)
	assert.Equal(t, "new-owner", renamed.OwnerLogin)
	assert.Equal(t, newName, renamed.RepoName)
	assert.Equal(t, int64(42), renamed.InstallationID.Int64)
	assert.True(t, renamed.SyncRefs)
	assert.Equal(t, GitHubSyncedRepoEnrolledViaImport, renamed.EnrolledVia)

	_, err = q.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: "octo", RepoName: oldName})
	require.Error(t, err, "the old slug no longer names a registry row")
	count, err := q.CountGitHubSyncedIssues(ctx, db.CountGitHubSyncedIssuesParams{
		SyncedRepoID: row.ID, Resource: "issues", State: "all",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), count, "the repository keeps its metadata across the rename")
}
