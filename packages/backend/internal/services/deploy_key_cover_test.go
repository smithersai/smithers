package services

import (
	"context"
	stdErrors "errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDeployKey_Cov_CreateDeployKeyDuplicateAndErrorBranches(t *testing.T) {
	validKey := mustGenerateEd25519AuthorizedKey(t)

	t.Run("fingerprint duplicate", func(t *testing.T) {
		svc := NewDeployKeyService(&mockDeployKeyQuerier{
			getByFingerprintFn: func(context.Context, db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				return db.DeployKey{ID: 9}, nil
			},
		})

		_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: validKey})
		require.Error(t, err)
		assert.Equal(t, http.StatusConflict, deployKeyCovStatus(t, err))
	})

	t.Run("fingerprint lookup error", func(t *testing.T) {
		svc := NewDeployKeyService(&mockDeployKeyQuerier{
			getByFingerprintFn: func(context.Context, db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				return db.DeployKey{}, pgx.ErrTxClosed
			},
		})

		_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: validKey})
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, deployKeyCovStatus(t, err))
	})

	t.Run("create unique violation", func(t *testing.T) {
		svc := NewDeployKeyService(&mockDeployKeyQuerier{
			createDeployKeyFn: func(context.Context, db.CreateDeployKeyParams) (db.DeployKey, error) {
				return db.DeployKey{}, &pgconn.PgError{Code: "23505"}
			},
		})

		_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: validKey})
		require.Error(t, err)
		assert.Equal(t, http.StatusConflict, deployKeyCovStatus(t, err))
	})

	t.Run("validation branches", func(t *testing.T) {
		svc := NewDeployKeyService(&mockDeployKeyQuerier{})
		_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{Title: strings.Repeat("x", 256), Key: validKey})
		require.Error(t, err)
		assert.Equal(t, http.StatusUnprocessableEntity, deployKeyCovStatus(t, err))

		_, err = svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{Title: "ci", Key: "not a key"})
		require.Error(t, err)
		assert.Equal(t, http.StatusUnprocessableEntity, deployKeyCovStatus(t, err))
	})
}

func TestDeployKey_Cov_DeleteLoadMapAndUniqueHelpers(t *testing.T) {
	svc := NewDeployKeyService(&mockDeployKeyQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrTxClosed
		},
	})
	_, err := svc.loadRepository(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, deployKeyCovStatus(t, err))

	svc = NewDeployKeyService(&mockDeployKeyQuerier{
		getDeployKeyByIDFn: func(context.Context, int64) (db.DeployKey, error) {
			return db.DeployKey{ID: 5, RepositoryID: 99}, nil
		},
	})
	err = svc.DeleteDeployKey(context.Background(), "alice", "demo", 5)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, deployKeyCovStatus(t, err))

	svc = NewDeployKeyService(&mockDeployKeyQuerier{
		deleteDeployKeyFn: func(context.Context, int64) error {
			return assert.AnError
		},
	})
	err = svc.DeleteDeployKey(context.Background(), "alice", "demo", 5)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, deployKeyCovStatus(t, err))

	lastUsed := time.Now().UTC()
	resp := mapDeployKeyResponse(db.DeployKey{
		ID:             8,
		Title:          "deploy",
		KeyFingerprint: "SHA256:test",
		PublicKey:      "ssh-ed25519 AAAA comment",
		ReadOnly:       true,
		LastUsedAt:     pgtype.Timestamptz{Time: lastUsed, Valid: true},
		CreatedAt:      lastUsed.Add(-time.Hour),
	})
	require.NotNil(t, resp.LastUsedAt)
	assert.Equal(t, lastUsed, *resp.LastUsedAt)
	assert.Equal(t, "ssh-ed25519", resp.KeyType)

	assert.False(t, isDeployKeyUniqueViolation(nil))
	assert.False(t, isDeployKeyUniqueViolation(assert.AnError))
	assert.True(t, isDeployKeyUniqueViolation(stdErrors.New("duplicate key value violates unique constraint")))
}

func deployKeyCovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
