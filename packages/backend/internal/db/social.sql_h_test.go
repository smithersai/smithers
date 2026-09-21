package db

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type socialSQLHDB = chunk4SQLHDB
type socialSQLHRow = chunk4SQLHRow
type socialSQLHRows = chunk4SQLHRows

func TestSocialSQL_H_PublicStarsAndWatchLists(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, uniqueTestUsername(t))
	starrerID := mustCreateUser(t, pool, uniqueTestUsername(t))
	watcherID := mustCreateUser(t, pool, uniqueTestUsername(t))
	participantID := mustCreateUser(t, pool, uniqueTestUsername(t))
	ignoredID := mustCreateUser(t, pool, uniqueTestUsername(t))
	publicRepoID := mustCreateRepo(t, pool, ownerID, uniqueTestRepoName(t))
	privateRepoID := mustCreateRepo(t, pool, ownerID, uniqueTestRepoName(t))
	mustExec(t, pool, `UPDATE repositories SET is_public = FALSE WHERE id = $1`, privateRepoID)

	_, err := q.StarRepo(ctx, StarRepoParams{UserID: starrerID, RepositoryID: publicRepoID})
	require.NoError(t, err)
	_, err = q.StarRepo(ctx, StarRepoParams{UserID: starrerID, RepositoryID: privateRepoID})
	require.NoError(t, err)
	_, err = q.WatchRepo(ctx, WatchRepoParams{UserID: watcherID, RepositoryID: publicRepoID, Mode: "watching"})
	require.NoError(t, err)
	_, err = q.WatchRepo(ctx, WatchRepoParams{UserID: participantID, RepositoryID: publicRepoID, Mode: "participating"})
	require.NoError(t, err)
	_, err = q.WatchRepo(ctx, WatchRepoParams{UserID: ignoredID, RepositoryID: publicRepoID, Mode: "ignored"})
	require.NoError(t, err)

	publicStarCount, err := q.CountPublicUserStarredRepos(ctx, starrerID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), publicStarCount)
	watchCount, err := q.CountUserWatchedRepos(ctx, watcherID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), watchCount)

	publicStarred, err := q.ListPublicUserStarredRepos(ctx, ListPublicUserStarredReposParams{UserID: starrerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, publicStarred, 1)
	assert.Equal(t, publicRepoID, publicStarred[0].ID)
	allStarred, err := q.ListUserStarredRepos(ctx, ListUserStarredReposParams{UserID: starrerID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, allStarred, 2)

	stargazers, err := q.ListRepoStargazers(ctx, ListRepoStargazersParams{RepositoryID: publicRepoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, stargazers, 1)
	assert.Equal(t, starrerID, stargazers[0].ID)

	watchers, err := q.ListRepoWatchers(ctx, ListRepoWatchersParams{RepositoryID: publicRepoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, watchers, 3)
	activeWatchers, err := q.ListActiveWatchersForRepo(ctx, publicRepoID)
	require.NoError(t, err)
	require.Len(t, activeWatchers, 2)
	assert.Equal(t, watcherID, activeWatchers[0].ID)
	assert.Equal(t, participantID, activeWatchers[1].ID)

	watchedRepos, err := q.ListUserWatchedRepos(ctx, ListUserWatchedReposParams{UserID: watcherID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, watchedRepos, 1)
	assert.Equal(t, "watching", watchedRepos[0].WatchMode)

	emptyPublicStarred, err := q.ListPublicUserStarredRepos(ctx, ListPublicUserStarredReposParams{UserID: 999999, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyPublicStarred)
	emptyWatchers, err := q.ListActiveWatchersForRepo(ctx, 999999)
	require.NoError(t, err)
	assert.Empty(t, emptyWatchers)
}

func TestSocialSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("social h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListActiveWatchersForRepo", func(q *Queries) error { _, err := q.ListActiveWatchersForRepo(context.Background(), 1); return err }},
		{"ListPublicUserStarredRepos", func(q *Queries) error {
			_, err := q.ListPublicUserStarredRepos(context.Background(), ListPublicUserStarredReposParams{UserID: 1, PageSize: 1})
			return err
		}},
		{"ListRepoStargazers", func(q *Queries) error {
			_, err := q.ListRepoStargazers(context.Background(), ListRepoStargazersParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListRepoWatchers", func(q *Queries) error {
			_, err := q.ListRepoWatchers(context.Background(), ListRepoWatchersParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListUserStarredRepos", func(q *Queries) error {
			_, err := q.ListUserStarredRepos(context.Background(), ListUserStarredReposParams{UserID: 1, PageSize: 1})
			return err
		}},
		{"ListUserWatchedRepos", func(q *Queries) error {
			_, err := q.ListUserWatchedRepos(context.Background(), ListUserWatchedReposParams{UserID: 1, PageSize: 1})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(socialSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(socialSQLHDB{rows: &socialSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(socialSQLHDB{rows: &socialSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestSocialSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("social h row failed")
	rowQ := New(socialSQLHDB{row: socialSQLHRow{err: sentinel}})
	_, err := rowQ.CountPublicUserStarredRepos(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CountUserWatchedRepos(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}
