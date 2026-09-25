package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The binder of a mirror is the user of the newest ready import that produced
// exactly that mirror repository from that GitHub source. Imports into other
// repositories, and imports that are not ready, never name the binder.
func TestListGitHubSyncedRepoMirrorBinders(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	maintainerName := uniqueTestUsername(t)
	readerName := uniqueTestUsername(t)
	maintainer := mustCreateUser(t, pool, maintainerName)
	reader := mustCreateUser(t, pool, readerName)
	source := uniqueTestRepoName(t)

	importJob := func(userID int64, repoOwner, status string) {
		_, err := pool.Exec(ctx, `INSERT INTO import_jobs (user_id, github_owner, github_repo, repo_owner, repo_name, branch, status)
			VALUES ($1, 'VictimCorp', $2, $3, $2, 'main', $4)`, userID, source, repoOwner, status)
		require.NoError(t, err)
	}
	importJob(maintainer, maintainerName, "ready")
	importJob(reader, readerName, "ready")      // a different mirror repo
	importJob(reader, maintainerName, "failed") // not ready

	row, err := q.EnrollGitHubSyncedRepo(ctx, EnrollGitHubSyncedRepoParams{
		OwnerLogin: "victimcorp", RepoName: source, SyncRefs: true, EnrolledVia: "import",
	})
	require.NoError(t, err)

	binders, err := q.ListGitHubSyncedRepoMirrorBinders(ctx)
	require.NoError(t, err)
	for _, b := range binders {
		assert.NotEqual(t, row.ID, b.SyncedRepoID, "a row without a recorded mirror has no binder")
	}

	require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, SetGitHubSyncedRepoMirrorParams{
		ID: row.ID, MirrorOwner: maintainerName, MirrorRepo: source,
	}))
	binders, err = q.ListGitHubSyncedRepoMirrorBinders(ctx)
	require.NoError(t, err)
	got := map[int64]int64{}
	for _, b := range binders {
		got[b.SyncedRepoID] = b.UserID
	}
	assert.Equal(t, maintainer, got[row.ID])
}
