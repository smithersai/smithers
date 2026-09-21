package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertBookmark_CreatesAndUpdatesTarget(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-upsert-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmark-upsert-repo")

	created, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
		RepositoryID:   repoID,
		Name:           "main",
		TargetChangeID: "kabc123",
		IsDefault:      true,
	})
	require.NoError(t, err)
	assert.Equal(t, "kabc123", created.TargetChangeID)
	assert.True(t, created.IsDefault)

	updated, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
		RepositoryID:   repoID,
		Name:           "main",
		TargetChangeID: "kxyz789",
		IsDefault:      false,
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, updated.ID)
	assert.Equal(t, "kxyz789", updated.TargetChangeID)
	assert.False(t, updated.IsDefault)
}

func TestSetDefaultBookmark_EnforcesSingleDefault(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-default-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmark-default-repo")

	_, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
		RepositoryID:   repoID,
		Name:           "main",
		TargetChangeID: "kmain123",
		IsDefault:      true,
	})
	require.NoError(t, err)
	_, err = q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
		RepositoryID:   repoID,
		Name:           "dev",
		TargetChangeID: "kdev123",
		IsDefault:      false,
	})
	require.NoError(t, err)

	rows, err := q.SetDefaultBookmark(context.Background(), SetDefaultBookmarkParams{
		RepositoryID: repoID,
		Name:         "dev",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), rows)

	bookmarks, err := q.ListBookmarksByRepo(context.Background(), ListBookmarksByRepoParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, bookmarks, 2)

	defaults := 0
	for _, bookmark := range bookmarks {
		if bookmark.IsDefault {
			defaults++
			assert.Equal(t, "dev", bookmark.Name)
		}
	}
	assert.Equal(t, 1, defaults)
}

func TestSetDefaultBookmark_MissingBookmarkReturnsErrorAndKeepsCurrentDefault(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-missing-default-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmark-missing-default-repo")

	_, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
		RepositoryID:   repoID,
		Name:           "main",
		TargetChangeID: "kmain123",
		IsDefault:      true,
	})
	require.NoError(t, err)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.SetDefaultBookmark(context.Background(), SetDefaultBookmarkParams{
			RepositoryID: repoID,
			Name:         "does-not-exist",
		})
		return err
	})

	bookmarks, err := q.ListBookmarksByRepo(context.Background(), ListBookmarksByRepoParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, bookmarks, 1)
	assert.Equal(t, "main", bookmarks[0].Name)
	assert.True(t, bookmarks[0].IsDefault)
}

func TestListBookmarksByRepo_OrdersAndPaginates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-list-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmark-list-repo")

	for _, name := range []string{"zeta", "main", "release"} {
		_, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
			RepositoryID:   repoID,
			Name:           name,
			TargetChangeID: "k-" + name,
			IsDefault:      false,
		})
		require.NoError(t, err)
	}

	testCases := []struct {
		name       string
		pageOffset int32
		pageSize   int32
		wantNames  []string
	}{
		{
			name:       "first-page",
			pageOffset: 0,
			pageSize:   2,
			wantNames:  []string{"main", "release"},
		},
		{
			name:       "second-page",
			pageOffset: 2,
			pageSize:   2,
			wantNames:  []string{"zeta"},
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := q.ListBookmarksByRepo(context.Background(), ListBookmarksByRepoParams{
				RepositoryID: repoID,
				PageSize:     tc.pageSize,
				PageOffset:   tc.pageOffset,
			})
			require.NoError(t, err)

			names := make([]string, 0, len(got))
			for _, bookmark := range got {
				names = append(names, bookmark.Name)
			}
			assert.Equal(t, tc.wantNames, names)
		})
	}
}

func TestListDefaultBookmarkHeadsByRepoIDs(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-head-list-user")
	withChangeID := mustCreateRepo(t, pool, userID, "bookmark-head-with-change")
	withoutChangeID := mustCreateRepo(t, pool, userID, "bookmark-head-without-change")
	withoutBookmarkID := mustCreateRepo(t, pool, userID, "bookmark-head-without-bookmark")

	_, err := q.UpsertChange(context.Background(), UpsertChangeParams{
		RepositoryID:    withChangeID,
		ChangeID:        "change-main",
		CommitID:        "commit-main",
		Description:     "default head",
		AuthorName:      "Alice",
		AuthorEmail:     "alice@example.com",
		ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)

	for repositoryID, changeID := range map[int64]string{
		withChangeID:    "change-main",
		withoutChangeID: "change-not-synchronized",
	} {
		_, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
			RepositoryID:   repositoryID,
			Name:           "main",
			TargetChangeID: changeID,
			IsDefault:      true,
		})
		require.NoError(t, err)
	}

	heads, err := q.ListDefaultBookmarkHeadsByRepoIDs(context.Background(), []int64{
		withChangeID,
		withoutChangeID,
		withoutBookmarkID,
	})
	require.NoError(t, err)
	require.Len(t, heads, 2)

	headsByRepoID := make(map[int64]ListDefaultBookmarkHeadsByRepoIDsRow, len(heads))
	for _, head := range heads {
		headsByRepoID[head.RepositoryID] = head
	}
	assert.Equal(t, "change-main", headsByRepoID[withChangeID].ChangeID)
	assert.Equal(t, "commit-main", headsByRepoID[withChangeID].CommitID)
	assert.Equal(t, "change-not-synchronized", headsByRepoID[withoutChangeID].ChangeID)
	assert.Empty(t, headsByRepoID[withoutChangeID].CommitID)
	assert.NotContains(t, headsByRepoID, withoutBookmarkID)
}

func TestDeleteBookmarkByName_DeletesMatchingBookmarkOnly(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bookmark-delete-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmark-delete-repo")

	for _, name := range []string{"main", "dev"} {
		_, err := q.UpsertBookmark(context.Background(), UpsertBookmarkParams{
			RepositoryID:   repoID,
			Name:           name,
			TargetChangeID: "k-" + name,
			IsDefault:      name == "main",
		})
		require.NoError(t, err)
	}

	rows, err := q.DeleteBookmarkByName(context.Background(), DeleteBookmarkByNameParams{
		RepositoryID: repoID,
		Name:         "dev",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	bookmarks, err := q.ListBookmarksByRepo(context.Background(), ListBookmarksByRepoParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, bookmarks, 1)
	assert.Equal(t, "main", bookmarks[0].Name)
	assert.True(t, bookmarks[0].IsDefault)
}
