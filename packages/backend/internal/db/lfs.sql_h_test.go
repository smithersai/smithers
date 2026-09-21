package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type lfsSQLHDB = chunk4SQLHDB
type lfsSQLHRow = chunk4SQLHRow
type lfsSQLHRows = chunk4SQLHRows

func TestLFSSQL_H_LocksAndObjectListing(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	lock, err := q.CreateLFSLock(ctx, CreateLFSLockParams{RepositoryID: repoID, Path: "assets/one.bin", OwnerID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, repoID, lock.RepositoryID)
	count, err := q.CountLFSLocks(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
	got, err := q.GetLFSLockByPath(ctx, GetLFSLockByPathParams{RepositoryID: repoID, Path: lock.Path})
	require.NoError(t, err)
	assert.Equal(t, lock.ID, got.ID)
	locks, err := q.ListLFSLocks(ctx, ListLFSLocksParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, locks, 1)

	require.NoError(t, q.DeleteLFSLockByPath(ctx, DeleteLFSLockByPathParams{RepositoryID: repoID, Path: lock.Path}))
	_, err = q.GetLFSLockByPath(ctx, GetLFSLockByPathParams{RepositoryID: repoID, Path: lock.Path})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	lock, err = q.CreateLFSLock(ctx, CreateLFSLockParams{RepositoryID: repoID, Path: "assets/two.bin", OwnerID: ownerID})
	require.NoError(t, err)
	require.NoError(t, q.DeleteLFSLockByID(ctx, DeleteLFSLockByIDParams{RepositoryID: repoID, ID: lock.ID}))
	_, err = q.GetLFSLockByPath(ctx, GetLFSLockByPathParams{RepositoryID: repoID, Path: lock.Path})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, q.DeleteLFSLockByID(ctx, DeleteLFSLockByIDParams{RepositoryID: repoID, ID: 999999}))
	locks, err = q.ListLFSLocks(ctx, ListLFSLocksParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, locks)

	_, err = q.CreateLFSObject(ctx, CreateLFSObjectParams{RepositoryID: repoID, Oid: lfsTestOID("a"), Size: 10, GcsPath: "gcs/a"})
	require.NoError(t, err)
	_, err = q.CreateLFSObject(ctx, CreateLFSObjectParams{RepositoryID: repoID, Oid: lfsTestOID("b"), Size: 20, GcsPath: "gcs/b"})
	require.NoError(t, err)
	objects, err := q.ListLFSObjects(ctx, ListLFSObjectsParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, objects, 2)
	assert.Equal(t, int64(10), objects[0].Size)
	emptyObjects, err := q.ListLFSObjects(ctx, ListLFSObjectsParams{RepositoryID: 999999, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyObjects)

	dup, err := q.CreateLFSLock(ctx, CreateLFSLockParams{RepositoryID: repoID, Path: "assets/dup.bin", OwnerID: ownerID})
	require.NoError(t, err)
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateLFSLock(ctx, CreateLFSLockParams{RepositoryID: repoID, Path: dup.Path, OwnerID: ownerID})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateLFSLock(ctx, CreateLFSLockParams{RepositoryID: 999999, Path: "bad", OwnerID: ownerID})
		return err
	})
}

func TestLFSSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("lfs h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListLFSLocks", func(q *Queries) error {
			_, err := q.ListLFSLocks(context.Background(), ListLFSLocksParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListLFSObjects", func(q *Queries) error {
			_, err := q.ListLFSObjects(context.Background(), ListLFSObjectsParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(lfsSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(lfsSQLHDB{rows: &lfsSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(lfsSQLHDB{rows: &lfsSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestLFSSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("lfs h failed")
	rowQ := New(lfsSQLHDB{row: lfsSQLHRow{err: sentinel}})
	_, err := rowQ.CountLFSLocks(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CreateLFSLock(context.Background(), CreateLFSLockParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetLFSLockByPath(context.Background(), GetLFSLockByPathParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(lfsSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteLFSLockByID(context.Background(), DeleteLFSLockByIDParams{}), sentinel)
	require.ErrorIs(t, execQ.DeleteLFSLockByPath(context.Background(), DeleteLFSLockByPathParams{}), sentinel)
}
