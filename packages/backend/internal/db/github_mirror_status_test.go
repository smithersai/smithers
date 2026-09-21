package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitHubMirrorStatusConfiguredAndReported(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	owner := uniqueTestUsername(t)
	repoName := uniqueTestRepoName(t)
	userID := mustCreateUser(t, pool, owner)
	repoID := mustCreateRepo(t, pool, userID, repoName)

	syncedRepo, err := q.EnrollGitHubSyncedRepo(ctx, EnrollGitHubSyncedRepoParams{
		OwnerLogin:  "octo",
		RepoName:    repoName,
		SyncRefs:    true,
		EnrolledVia: "import",
	})
	require.NoError(t, err)
	require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, SetGitHubSyncedRepoMirrorParams{
		ID:          syncedRepo.ID,
		MirrorOwner: owner,
		MirrorRepo:  repoName,
	}))

	repository, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, "behind", repository.MirrorStatus)
	assert.False(t, repository.LastMirrorAt.Valid)

	rows, err := q.RecordGitHubMirrorStatus(ctx, RecordGitHubMirrorStatusParams{
		MirrorStatus: "synced",
		GithubHead:   pgtype.Text{String: "0123456789abcdef", Valid: true},
		MirrorOwner:  owner,
		MirrorRepo:   repoName,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	repository, err = q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, "synced", repository.MirrorStatus)
	assert.True(t, repository.LastMirrorAt.Valid)
	assert.Equal(t, "0123456789abcdef", repository.LastMirrorGithubHead.String)
	assert.False(t, repository.LastMirrorError.Valid)

	rows, err = q.RecordGitHubMirrorStatus(ctx, RecordGitHubMirrorStatusParams{
		MirrorStatus: "failed",
		MirrorError:  pgtype.Text{String: "push rejected", Valid: true},
		MirrorOwner:  owner,
		MirrorRepo:   repoName,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	repository, err = q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, "failed", repository.MirrorStatus)
	assert.Equal(t, "push rejected", repository.LastMirrorError.String)
	assert.Equal(t, "0123456789abcdef", repository.LastMirrorGithubHead.String,
		"a failed run retains the head from the last successful push")
}
