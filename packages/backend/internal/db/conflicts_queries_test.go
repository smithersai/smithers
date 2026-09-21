package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertConflict_CreatesAndUpdatesByFile(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-upsert-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-upsert-repo")

	created, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
		RepositoryID: repoID,
		ChangeID:     "kconflict1",
		FilePath:     "README.md",
		ConflictType: "content",
	})
	require.NoError(t, err)
	assert.Equal(t, "content", created.ConflictType)
	assert.False(t, created.Resolved)

	updated, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
		RepositoryID: repoID,
		ChangeID:     "kconflict1",
		FilePath:     "README.md",
		ConflictType: "rename",
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, updated.ID)
	assert.Equal(t, "rename", updated.ConflictType)
}

func TestMarkConflictResolved_SetsResolvedMetadata(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-resolve-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-resolve-repo")

	_, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
		RepositoryID: repoID,
		ChangeID:     "kresolve1",
		FilePath:     "src/main.go",
		ConflictType: "content",
	})
	require.NoError(t, err)

	rows, err := q.MarkConflictResolved(context.Background(), MarkConflictResolvedParams{
		RepositoryID:     repoID,
		ChangeID:         "kresolve1",
		FilePath:         "src/main.go",
		ResolvedBy:       pgtype.Int8{Int64: userID, Valid: true},
		ResolutionMethod: "manual",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	conflicts, err := q.ListConflictsByChangeID(context.Background(), ListConflictsByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "kresolve1",
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, conflicts, 1)
	assert.True(t, conflicts[0].Resolved)
	assert.Equal(t, "manual", conflicts[0].ResolutionMethod)
	assert.True(t, conflicts[0].ResolvedBy.Valid)
	assert.Equal(t, userID, conflicts[0].ResolvedBy.Int64)
	assert.True(t, conflicts[0].ResolvedAt.Valid)
}

func TestGetConflictByPath_ReturnsExactConflict(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-get-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-get-repo")
	for _, filePath := range []string{"src/first.go", "src/second.go"} {
		_, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
			RepositoryID: repoID,
			ChangeID:     "kget1",
			FilePath:     filePath,
			ConflictType: "content",
		})
		require.NoError(t, err)
	}

	conflict, err := q.GetConflictByPath(context.Background(), GetConflictByPathParams{
		RepositoryID: repoID,
		ChangeID:     "kget1",
		FilePath:     "src/second.go",
	})

	require.NoError(t, err)
	assert.Equal(t, "src/second.go", conflict.FilePath)
}

func TestUpsertConflict_ReopensResolvedConflictOnRefresh(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-reopen-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-reopen-repo")

	_, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
		RepositoryID: repoID,
		ChangeID:     "kreopen1",
		FilePath:     "src/conflicted.go",
		ConflictType: "content",
	})
	require.NoError(t, err)

	_, err = q.MarkConflictResolved(context.Background(), MarkConflictResolvedParams{
		RepositoryID:     repoID,
		ChangeID:         "kreopen1",
		FilePath:         "src/conflicted.go",
		ResolvedBy:       pgtype.Int8{Int64: userID, Valid: true},
		ResolutionMethod: "manual",
	})
	require.NoError(t, err)

	refreshed, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
		RepositoryID: repoID,
		ChangeID:     "kreopen1",
		FilePath:     "src/conflicted.go",
		ConflictType: "rename",
	})
	require.NoError(t, err)
	assert.Equal(t, "rename", refreshed.ConflictType)
	assert.False(t, refreshed.Resolved)
	assert.False(t, refreshed.ResolvedBy.Valid)
	assert.Equal(t, "", refreshed.ResolutionMethod)
	assert.False(t, refreshed.ResolvedAt.Valid)
}

func TestListConflictsByChangeID_Paginates(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-list-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-list-repo")

	for _, filePath := range []string{"a.txt", "b.txt", "c.txt"} {
		_, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
			RepositoryID: repoID,
			ChangeID:     "klist1",
			FilePath:     filePath,
			ConflictType: "content",
		})
		require.NoError(t, err)
	}

	page, err := q.ListConflictsByChangeID(context.Background(), ListConflictsByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "klist1",
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, "b.txt", page[0].FilePath)
}

func TestDeleteConflictsByChangeID_DeletesOnlyMatchingChange(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "conflict-delete-user")
	repoID := mustCreateRepo(t, pool, userID, "conflict-delete-repo")

	for _, tc := range []struct {
		changeID string
		filePath string
	}{
		{changeID: "k-delete", filePath: "a.txt"},
		{changeID: "k-delete", filePath: "b.txt"},
		{changeID: "k-keep", filePath: "c.txt"},
	} {
		_, err := q.UpsertConflict(context.Background(), UpsertConflictParams{
			RepositoryID: repoID,
			ChangeID:     tc.changeID,
			FilePath:     tc.filePath,
			ConflictType: "content",
		})
		require.NoError(t, err)
	}

	rows, err := q.DeleteConflictsByChangeID(context.Background(), DeleteConflictsByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "k-delete",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), rows)

	remaining, err := q.ListConflictsByChangeID(context.Background(), ListConflictsByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "k-keep",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, "c.txt", remaining[0].FilePath)

	deletedRows, err := q.ListConflictsByChangeID(context.Background(), ListConflictsByChangeIDParams{
		RepositoryID: repoID,
		ChangeID:     "k-delete",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	assert.Empty(t, deletedRows)
}
