package db

import (
	"context"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func lfsTestOID(last string) string {
	return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + last
}

func TestCreateLFSObject_Success(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo")
	row, err := q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: lfsTestOID("1"), Size: 123, GcsPath: "lfs/repo/object-1"})
	require.NoError(t, err)
	assert.Equal(t, repoID, row.RepositoryID)
	assert.Equal(t, int64(123), row.Size)
}

func TestCreateLFSObject_DuplicateOID(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner-dup")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo-dup")
	oid := lfsTestOID("2")
	_, err := q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: oid, Size: 42, GcsPath: "k"})
	require.NoError(t, err)
	_, err = q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: oid, Size: 42, GcsPath: "k"})
	require.Error(t, err)
}

func TestGetLFSObject_ByOID(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner-get")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo-get")
	oid := lfsTestOID("3")
	created, _ := q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: oid, Size: 256, GcsPath: "g"})
	got, err := q.GetLFSObjectByOID(context.Background(), GetLFSObjectByOIDParams{RepositoryID: repoID, Oid: oid})
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
}

func TestGetLFSObject_NotFound(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner-not-found")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo-not-found")
	_, err := q.GetLFSObjectByOID(context.Background(), GetLFSObjectByOIDParams{RepositoryID: repoID, Oid: lfsTestOID("4")})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestDeleteLFSObject_Success(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner-delete")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo-delete")
	oid := lfsTestOID("5")
	created, err := q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: oid, Size: 512, GcsPath: "g"})
	require.NoError(t, err)
	deleted, err := q.DeleteLFSObject(context.Background(), DeleteLFSObjectParams{ID: created.ID, RepositoryID: repoID, Oid: oid})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	deleted, err = q.DeleteLFSObject(context.Background(), DeleteLFSObjectParams{ID: created.ID, RepositoryID: repoID, Oid: oid})
	require.NoError(t, err)
	assert.Zero(t, deleted, "the exact-row CAS must expose a lost or repeated delete")
	_, err = q.GetLFSObjectByOID(context.Background(), GetLFSObjectByOIDParams{RepositoryID: repoID, Oid: oid})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestListLFSObjects_Pagination(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "lfs-owner-list")
	repoID := mustCreateRepo(t, pool, ownerID, "lfs-repo-list")
	for i := 0; i < 3; i++ {
		_, err := q.CreateLFSObject(context.Background(), CreateLFSObjectParams{RepositoryID: repoID, Oid: lfsTestOID(strconv.Itoa(6 + i)), Size: int64(100 + i), GcsPath: "g"})
		require.NoError(t, err)
	}
	total, _ := q.CountLFSObjects(context.Background(), repoID)
	assert.Equal(t, int64(3), total)
	rows, err := q.ListLFSObjects(context.Background(), ListLFSObjectsParams{RepositoryID: repoID, PageOffset: 1, PageSize: 1})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int64(101), rows[0].Size)
}
