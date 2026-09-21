package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestDeployKey_Z_ListCreateAndDeleteErrorBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	key := mustGenerateEd25519AuthorizedKey(t)

	svc := NewDeployKeyService(&mockDeployKeyQuerier{
		listDeployKeysFn: func(context.Context, int64) ([]db.DeployKey, error) {
			return nil, errors.New("list failed")
		},
	})
	_, err := svc.ListDeployKeys(ctx, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewDeployKeyService(&mockDeployKeyQuerier{}).CreateDeployKey(ctx, "alice", "demo", CreateDeployKeyRequest{
		Title: strings.Repeat("a", 256),
		Key:   key,
	})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	_, err = NewDeployKeyService(&mockDeployKeyQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}).CreateDeployKey(ctx, "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: key})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	for _, tc := range []struct {
		name string
		q    *mockDeployKeyQuerier
		want int
	}{
		{
			name: "duplicate lookup finds row",
			q: &mockDeployKeyQuerier{
				getByFingerprintFn: func(context.Context, db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
					return db.DeployKey{ID: 1}, nil
				},
			},
			want: http.StatusConflict,
		},
		{
			name: "duplicate lookup fails",
			q: &mockDeployKeyQuerier{
				getByFingerprintFn: func(context.Context, db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
					return db.DeployKey{}, errors.New("lookup failed")
				},
			},
			want: http.StatusInternalServerError,
		},
		{
			name: "unique violation on create",
			q: &mockDeployKeyQuerier{
				createDeployKeyFn: func(context.Context, db.CreateDeployKeyParams) (db.DeployKey, error) {
					return db.DeployKey{}, &pgconn.PgError{Code: "23505"}
				},
			},
			want: http.StatusConflict,
		},
		{
			name: "insert failure",
			q: &mockDeployKeyQuerier{
				createDeployKeyFn: func(context.Context, db.CreateDeployKeyParams) (db.DeployKey, error) {
					return db.DeployKey{}, errors.New("insert failed")
				},
			},
			want: http.StatusInternalServerError,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewDeployKeyService(tc.q).CreateDeployKey(ctx, "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: key})
			assert.Equal(t, tc.want, apiStatus(t, err))
		})
	}

	for _, tc := range []struct {
		name string
		q    *mockDeployKeyQuerier
		want int
	}{
		{
			name: "load repository fails",
			q: &mockDeployKeyQuerier{
				getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return db.Repository{}, errors.New("repo failed")
				},
			},
			want: http.StatusInternalServerError,
		},
		{
			name: "load key fails",
			q: &mockDeployKeyQuerier{
				getDeployKeyByIDFn: func(context.Context, int64) (db.DeployKey, error) {
					return db.DeployKey{}, errors.New("key failed")
				},
			},
			want: http.StatusInternalServerError,
		},
		{
			name: "foreign key",
			q: &mockDeployKeyQuerier{
				getDeployKeyByIDFn: func(context.Context, int64) (db.DeployKey, error) {
					return db.DeployKey{ID: 7, RepositoryID: 99}, nil
				},
			},
			want: http.StatusNotFound,
		},
		{
			name: "delete fails",
			q: &mockDeployKeyQuerier{
				deleteDeployKeyFn: func(context.Context, int64) error {
					return errors.New("delete failed")
				},
			},
			want: http.StatusInternalServerError,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := NewDeployKeyService(tc.q).DeleteDeployKey(ctx, "alice", "demo", 7)
			assert.Equal(t, tc.want, apiStatus(t, err))
		})
	}

	require.NoError(t, NewDeployKeyService(&mockDeployKeyQuerier{}).DeleteDeployKey(ctx, "alice", "demo", 7))
	created, err := NewDeployKeyService(&mockDeployKeyQuerier{}).CreateDeployKey(ctx, "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: key, ReadOnly: true})
	require.NoError(t, err)
	assert.Equal(t, "ci", created.Title)
	assert.True(t, created.ReadOnly)
	_, err = NewDeployKeyService(&mockDeployKeyQuerier{}).CreateDeployKey(ctx, "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: mustGenerateRSAAuthorizedKey(t, 1024)})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	assert.True(t, isDeployKeyUniqueViolation(errors.New("UNIQUE constraint failed")))
	assert.False(t, isDeployKeyUniqueViolation(&pgconn.PgError{Code: "23514"}))
	assert.False(t, isDeployKeyUniqueViolation(nil))
	assert.ErrorIs(t, pgx.ErrNoRows, pgx.ErrNoRows)
}
