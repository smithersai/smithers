package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStarAndWatchRepo(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "social-user")
	ownerID := mustCreateUser(t, pool, "social-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "social-repo")

	_, err := q.StarRepo(context.Background(), StarRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)

	// A duplicate star is ON CONFLICT DO NOTHING: no row comes back, callers
	// see pgx.ErrNoRows and skip side effects instead of hitting a 23505.
	_, err = q.StarRepo(context.Background(), StarRepoParams{UserID: userID, RepositoryID: repoID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	unstarred, err := q.UnstarRepo(context.Background(), UnstarRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), unstarred)

	var starCount int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM stars WHERE user_id = $1 AND repository_id = $2`, userID, repoID).Scan(&starCount)
	require.NoError(t, err)
	assert.Equal(t, int64(0), starCount)

	_, err = q.WatchRepo(context.Background(), WatchRepoParams{UserID: userID, RepositoryID: repoID, Mode: "watching"})
	require.NoError(t, err)

	unwatched, err := q.UnwatchRepo(context.Background(), UnwatchRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), unwatched)

	var watchCount int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM watches WHERE user_id = $1 AND repository_id = $2`, userID, repoID).Scan(&watchCount)
	require.NoError(t, err)
	assert.Equal(t, int64(0), watchCount)
}

func TestSocialListingAndCountQueries(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "social-owner-2")
	starrerID := mustCreateUser(t, pool, "social-starrer")
	watcherID := mustCreateUser(t, pool, "social-watcher")
	repoID := mustCreateRepo(t, pool, ownerID, "social-repo-2")

	_, err := q.StarRepo(context.Background(), StarRepoParams{UserID: starrerID, RepositoryID: repoID})
	require.NoError(t, err)
	_, err = q.WatchRepo(context.Background(), WatchRepoParams{UserID: watcherID, RepositoryID: repoID, Mode: "watching"})
	require.NoError(t, err)

	isStarred, err := q.IsRepoStarred(context.Background(), IsRepoStarredParams{
		UserID:       starrerID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)
	assert.True(t, isStarred)

	starredRepos, err := q.ListUserStarredRepos(context.Background(), ListUserStarredReposParams{
		UserID:     starrerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, starredRepos, 1)
	assert.Equal(t, repoID, starredRepos[0].ID)

	stargazers, err := q.ListRepoStargazers(context.Background(), ListRepoStargazersParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, stargazers, 1)
	assert.Equal(t, starrerID, stargazers[0].ID)

	watchers, err := q.ListRepoWatchers(context.Background(), ListRepoWatchersParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, watchers, 1)
	assert.Equal(t, watcherID, watchers[0].ID)
	assert.Equal(t, "watching", watchers[0].Mode)

	watchStatus, err := q.GetWatchStatus(context.Background(), GetWatchStatusParams{
		UserID:       watcherID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)
	assert.Equal(t, "watching", watchStatus.Mode)

	starCount, err := q.CountRepoStars(context.Background(), repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), starCount)

	watchCount, err := q.CountRepoWatchers(context.Background(), repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), watchCount)
}

func TestCountUserStarredRepos(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "count-star-owner")
	starrerID := mustCreateUser(t, pool, "count-star-user")
	otherUserID := mustCreateUser(t, pool, "count-star-other")

	repoA := mustCreateRepo(t, pool, ownerID, "count-star-a")
	repoB := mustCreateRepo(t, pool, ownerID, "count-star-b")
	repoC := mustCreateRepo(t, pool, ownerID, "count-star-c")

	_, err := q.StarRepo(context.Background(), StarRepoParams{UserID: starrerID, RepositoryID: repoA})
	require.NoError(t, err)
	_, err = q.StarRepo(context.Background(), StarRepoParams{UserID: starrerID, RepositoryID: repoB})
	require.NoError(t, err)
	_, err = q.StarRepo(context.Background(), StarRepoParams{UserID: otherUserID, RepositoryID: repoC})
	require.NoError(t, err)

	count, err := q.CountUserStarredRepos(context.Background(), starrerID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}
