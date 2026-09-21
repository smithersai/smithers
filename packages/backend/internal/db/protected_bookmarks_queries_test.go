package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertProtectedBookmark_CreatesAndUpdates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "protected-bookmark-upsert-user")
	repoID := mustCreateRepo(t, pool, userID, "protected-bookmark-upsert-repo")

	created, err := q.UpsertProtectedBookmark(context.Background(), UpsertProtectedBookmarkParams{
		RepositoryID:          repoID,
		Pattern:               "main",
		RequireReview:         true,
		RequireHumanApprovals: 1,
		RequireAgentLgtm:      true,
		RequiredChecks:        []string{"ci"},
		DismissStaleReviews:   true,
		RestrictPushTeams:     []string{"maintainers"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), created.RequireHumanApprovals)
	assert.True(t, created.RequireAgentLgtm)
	assert.True(t, created.RequireReview)
	assert.Equal(t, []string{"ci"}, created.RequiredChecks)
	assert.True(t, created.DismissStaleReviews)
	assert.Equal(t, []string{"maintainers"}, created.RestrictPushTeams)

	updated, err := q.UpsertProtectedBookmark(context.Background(), UpsertProtectedBookmarkParams{
		RepositoryID:          repoID,
		Pattern:               "main",
		RequireReview:         true,
		RequireHumanApprovals: 2,
		RequireAgentLgtm:      false,
		RequiredChecks:        []string{"ci", "lint"},
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, updated.ID)
	assert.Equal(t, int64(2), updated.RequireHumanApprovals)
	assert.False(t, updated.RequireAgentLgtm)
	assert.Equal(t, []string{"ci", "lint"}, updated.RequiredChecks)
}

func TestListProtectedBookmarksByRepo_Paginates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "protected-bookmark-list-user")
	repoID := mustCreateRepo(t, pool, userID, "protected-bookmark-list-repo")

	for _, pattern := range []string{"main", "release/*", "stable/*"} {
		_, err := q.UpsertProtectedBookmark(context.Background(), UpsertProtectedBookmarkParams{
			RepositoryID:          repoID,
			Pattern:               pattern,
			RequireReview:         true,
			RequireHumanApprovals: 1,
		})
		require.NoError(t, err)
	}

	page, err := q.ListProtectedBookmarksByRepo(context.Background(), ListProtectedBookmarksByRepoParams{
		RepositoryID: repoID,
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, "release/*", page[0].Pattern)
}

func TestDeleteProtectedBookmarkByPattern(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "protected-bookmark-delete-user")
	repoID := mustCreateRepo(t, pool, userID, "protected-bookmark-delete-repo")

	_, err := q.UpsertProtectedBookmark(context.Background(), UpsertProtectedBookmarkParams{
		RepositoryID:          repoID,
		Pattern:               "main",
		RequireReview:         true,
		RequireHumanApprovals: 1,
	})
	require.NoError(t, err)

	rows, err := q.DeleteProtectedBookmarkByPattern(context.Background(), DeleteProtectedBookmarkByPatternParams{
		RepositoryID: repoID,
		Pattern:      "main",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	list, err := q.ListProtectedBookmarksByRepo(context.Background(), ListProtectedBookmarksByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	assert.Empty(t, list)
}
