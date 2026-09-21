package services

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type lfsHErrReader struct{}

func (lfsHErrReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (lfsHErrReader) Close() error             { return nil }

func TestLfs_H_BatchObjectStorageBranches(t *testing.T) {
	ctx := context.Background()
	actor := lfsUser()
	oid := strings.Repeat("a", 64)
	row := db.LfsObject{ID: 9, RepositoryID: lfsRepo().ID, Oid: oid, Size: 3, GcsPath: "stored/key"}

	t.Run("upload missing row signs object key", func(t *testing.T) {
		var signedKey string
		svc := NewLFSService(&mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return lfsRepo(), nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return db.LfsObject{}, pgx.ErrNoRows
			},
		}, &mockBlobStore{
			signedUploadURLFn: func(_ context.Context, key, contentType string, _ int64, expiry time.Duration) (string, error) {
				signedKey = key
				assert.Equal(t, "application/octet-stream", contentType)
				assert.Equal(t, time.Minute, expiry)
				return "https://upload/missing", nil
			},
		}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

		resp, err := svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.NoError(t, err)
		require.Len(t, resp.Objects, 1)
		assert.Equal(t, lfsObjectKey(lfsRepo().ID, oid), signedKey)
		assert.Equal(t, "https://upload/missing", resp.Objects[0].Actions["upload"].Href)
	})

	t.Run("upload missing row signing failure", func(t *testing.T) {
		svc := NewLFSService(&mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return lfsRepo(), nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return db.LfsObject{}, pgx.ErrNoRows
			},
		}, &mockBlobStore{
			signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
				return "", errors.New("sign failed")
			},
		}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

		_, err := svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("load and exists failures", func(t *testing.T) {
		svc := NewLFSService(&mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return lfsRepo(), nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return db.LfsObject{}, errors.New("select failed")
			},
		}, &mockBlobStore{}, time.Minute)
		_, err := svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewLFSService(&mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return lfsRepo(), nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return row, nil
			},
		}, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) {
				return false, errors.New("exists failed")
			},
		}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
		_, err = svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("upload existing row states", func(t *testing.T) {
		q := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return lfsRepo(), nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return row, nil
			},
		}
		svc := NewLFSService(q, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return true, nil },
		}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
		resp, err := svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.NoError(t, err)
		assert.Empty(t, resp.Objects[0].Actions)

		svc = NewLFSService(q, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, nil },
			signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
				return "https://upload/stored", nil
			},
		}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
		resp, err = svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.NoError(t, err)
		assert.Equal(t, "https://upload/stored", resp.Objects[0].Actions["upload"].Href)

		svc = NewLFSService(q, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, nil },
			signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
				return "", errors.New("sign failed")
			},
		}, time.Minute)
		_, err = svc.Batch(ctx, actor, "alice", "demo", LFSBatchInput{Operation: "upload", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("download registered missing blob and signed URL failure", func(t *testing.T) {
		q := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				repo := lfsRepo()
				repo.IsPublic = true
				return repo, nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return row, nil
			},
		}
		svc := NewLFSService(q, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return false, nil },
		}, time.Minute)
		resp, err := svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.NoError(t, err)
		require.NotNil(t, resp.Objects[0].Error)
		assert.Equal(t, 404, resp.Objects[0].Error.Code)

		svc = NewLFSService(q, &mockBlobStore{
			existsFn: func(context.Context, string) (bool, error) { return true, nil },
			signedDownloadURLFn: func(context.Context, string, time.Duration) (string, error) {
				return "", errors.New("download sign failed")
			},
		}, time.Minute)
		_, err = svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{Operation: "download", Objects: []LFSObjectInput{{Oid: oid, Size: 3}}})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})
}

func TestLfs_H_ConfirmValidateDeleteAndListBranches(t *testing.T) {
	ctx := context.Background()
	actor := lfsUser()
	body := "hello lfs"
	oid := lfsCovOID(body)
	repo := lfsRepo()
	key := lfsObjectKey(repo.ID, oid)

	t.Run("unique violation returns existing object and nonunique fails", func(t *testing.T) {
		existing := db.LfsObject{ID: 44, RepositoryID: repo.ID, Oid: oid, Size: int64(len(body)), GcsPath: key}
		q := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createLFSObjectFn: func(context.Context, db.CreateLFSObjectParams) (db.LfsObject, error) {
				return db.LfsObject{}, &pgconn.PgError{Code: "23505"}
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return existing, nil
			},
		}
		svc := NewLFSService(q, &mockBlobStore{
			newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(body)), nil
			},
		}, time.Minute)
		got, err := svc.ConfirmUpload(ctx, actor, "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
		require.NoError(t, err)
		assert.Equal(t, existing.ID, got.ID)

		q.getLFSObjectByOIDFn = func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
			return db.LfsObject{}, errors.New("lookup failed")
		}
		_, err = svc.ConfirmUpload(ctx, actor, "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})

	t.Run("blob verification failures", func(t *testing.T) {
		base := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		svc := NewLFSService(base, &mockBlobStore{
			newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
				return nil, errors.New("reader failed")
			},
		}, time.Minute)
		err := svc.validateUploadedBlob(ctx, key, oid, int64(len(body)))
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewLFSService(base, &mockBlobStore{
			newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
				return lfsHErrReader{}, nil
			},
		}, time.Minute)
		err = svc.validateUploadedBlob(ctx, key, oid, int64(len(body)))
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))

		svc = NewLFSService(base, &mockBlobStore{
			newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(body)), nil
			},
		}, time.Minute)
		err = svc.validateUploadedBlob(ctx, key, strings.Repeat("f", 64), int64(len(body)))
		require.Error(t, err)
		assert.Equal(t, 422, apiStatus(t, err))
	})

	t.Run("delete success and metadata delete failure", func(t *testing.T) {
		q := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLFSObjectByOIDFn: func(context.Context, db.GetLFSObjectByOIDParams) (db.LfsObject, error) {
				return db.LfsObject{RepositoryID: repo.ID, Oid: oid, GcsPath: key}, nil
			},
		}
		svc := NewLFSService(q, &mockBlobStore{}, time.Minute)
		require.NoError(t, svc.DeleteObject(ctx, actor, "alice", "demo", oid))

		q.deleteLFSObjectFn = func(context.Context, db.DeleteLFSObjectParams) (int64, error) {
			return 0, errors.New("delete row failed")
		}
		err := svc.DeleteObject(ctx, actor, "alice", "demo", oid)
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))

		q.deleteLFSObjectFn = func(context.Context, db.DeleteLFSObjectParams) (int64, error) {
			return 0, nil
		}
		err = svc.DeleteObject(ctx, actor, "alice", "demo", oid)
		require.Error(t, err)
		assert.Equal(t, 409, apiStatus(t, err))
	})

	t.Run("list success and list failure", func(t *testing.T) {
		q := &mockLFSQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				repo := repo
				repo.IsPublic = true
				return repo, nil
			},
			countLFSObjectsFn: func(context.Context, int64) (int64, error) { return 2, nil },
			listLFSObjectsFn: func(context.Context, db.ListLFSObjectsParams) ([]db.LfsObject, error) {
				return []db.LfsObject{{ID: 1}, {ID: 2}}, nil
			},
		}
		svc := NewLFSService(q, &mockBlobStore{}, time.Minute)
		rows, total, err := svc.ListObjects(ctx, nil, "alice", "demo", 1, 25)
		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		assert.Len(t, rows, 2)

		q.listLFSObjectsFn = func(context.Context, db.ListLFSObjectsParams) ([]db.LfsObject, error) {
			return nil, errors.New("list failed")
		}
		_, _, err = svc.ListObjects(ctx, nil, "alice", "demo", 1, 25)
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
	})
}

func TestLfs_H_AccessAndValidationBranches(t *testing.T) {
	ctx := context.Background()
	repo := db.Repository{ID: 77, OrgID: pgtype.Int8{Int64: 5, Valid: true}}
	actor := &db.User{ID: 9, Username: "member"}

	q := &mockLFSQuerier{
		isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepoFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return " read ", nil
		},
		getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
	}
	svc := NewLFSService(q, &mockBlobStore{}, time.Minute)
	permission, owner, err := svc.repoPermissionForUser(ctx, repo, actor.ID)
	require.NoError(t, err)
	assert.False(t, owner)
	assert.Equal(t, "read", permission)
	require.NoError(t, svc.requireReadAccess(ctx, repo, actor))
	err = svc.requireWriteAccess(ctx, repo, actor)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	q.getHighestTeamPermissionForRepoFn = func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
		return "", errors.New("team lookup failed")
	}
	err = svc.requireReadAccess(ctx, repo, actor)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = svc.resolveRepoByOwnerAndName(ctx, "alice", "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewLFSService(&mockLFSQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("db down")
		},
	}, &mockBlobStore{}, time.Minute)
	_, err = svc.resolveRepoByOwnerAndName(ctx, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, _, err = validateLFSObjectInput(LFSObjectInput{Oid: strings.Repeat("1", 64), Size: -1})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	_, err = validateLFSOID(strings.Repeat("g", 64))
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
}
