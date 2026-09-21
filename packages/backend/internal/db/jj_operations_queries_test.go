package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateJjOperation_PersistsOperationChain(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "jj-op-create-user")
	repoID := mustCreateRepo(t, pool, userID, "jj-op-create-repo")
	workspaceID := mustCreateWorkspace(t, pool, userID, repoID)

	root, err := q.CreateJjOperation(context.Background(), CreateJjOperationParams{
		RepositoryID:      repoID,
		OperationID:       "op-root",
		OperationType:     "describe",
		Description:       "root operation",
		UserID:            userID,
		ParentOperationID: "",
		WorkspaceID:       workspaceID,
		ChangeIds:         []string{"change-a", "change-b"},
	})
	require.NoError(t, err)
	assert.Equal(t, "op-root", root.OperationID)
	assert.True(t, root.WorkspaceID.Valid)
	assert.Equal(t, []string{"change-a", "change-b"}, root.ChangeIds)

	child, err := q.CreateJjOperation(context.Background(), CreateJjOperationParams{
		RepositoryID:      repoID,
		OperationID:       "op-child",
		OperationType:     "rebase",
		Description:       "child operation",
		UserID:            userID,
		ParentOperationID: "op-root",
		WorkspaceID:       workspaceID,
		ChangeIds:         []string{"change-b"},
	})
	require.NoError(t, err)
	assert.Equal(t, "op-root", child.ParentOperationID)

	forChange, err := q.ListJjOperationsForChange(context.Background(), ListJjOperationsForChangeParams{
		RepositoryID: repoID,
		ChangeID:     "change-a",
	})
	require.NoError(t, err)
	require.Len(t, forChange, 1)
	assert.Equal(t, "op-root", forChange[0].OperationID)

	owned, err := q.GetJjOperationForWorkspace(context.Background(), GetJjOperationForWorkspaceParams{
		RepositoryID: repoID,
		OperationID:  "op-root",
		WorkspaceID:  workspaceID,
	})
	require.NoError(t, err)
	assert.Equal(t, "op-root", owned.OperationID)

	later, err := q.CountLaterJjOperationsInWorkspace(context.Background(), CountLaterJjOperationsInWorkspaceParams{
		RepositoryID: repoID,
		WorkspaceID:  workspaceID,
		CreatedAt:    root.CreatedAt,
		ID:           root.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), later)
}

func TestListJjOperationsByRepo_ReturnsNewestFirst(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "jj-op-list-user")
	repoID := mustCreateRepo(t, pool, userID, "jj-op-list-repo")

	for _, opID := range []string{"op-1", "op-2", "op-3"} {
		_, err := q.CreateJjOperation(context.Background(), CreateJjOperationParams{
			RepositoryID:      repoID,
			OperationID:       opID,
			OperationType:     "describe",
			Description:       opID,
			UserID:            userID,
			ParentOperationID: "",
		})
		require.NoError(t, err)
	}

	rows, err := q.ListJjOperationsByRepo(context.Background(), ListJjOperationsByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     2,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "op-3", rows[0].OperationID)
	assert.Equal(t, "op-2", rows[1].OperationID)
}

func TestGetJjOperationByOperationID(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "jj-op-get-user")
	repoID := mustCreateRepo(t, pool, userID, "jj-op-get-repo")

	_, err := q.CreateJjOperation(context.Background(), CreateJjOperationParams{
		RepositoryID:      repoID,
		OperationID:       "op-get-1",
		OperationType:     "squash",
		Description:       "get me",
		UserID:            userID,
		ParentOperationID: "",
	})
	require.NoError(t, err)

	got, err := q.GetJjOperationByOperationID(context.Background(), GetJjOperationByOperationIDParams{
		RepositoryID: repoID,
		OperationID:  "op-get-1",
	})
	require.NoError(t, err)
	assert.Equal(t, "squash", got.OperationType)
	assert.Equal(t, "get me", got.Description)
}
