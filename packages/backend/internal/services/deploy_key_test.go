package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockDeployKeyQuerier struct {
	getRepoFn          func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	createDeployKeyFn  func(ctx context.Context, arg db.CreateDeployKeyParams) (db.DeployKey, error)
	getDeployKeyByIDFn func(ctx context.Context, id int64) (db.DeployKey, error)
	getByFingerprintFn func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error)
	listDeployKeysFn   func(ctx context.Context, repositoryID int64) ([]db.DeployKey, error)
	deleteDeployKeyFn  func(ctx context.Context, id int64) error
}

func (m *mockDeployKeyQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.Repository{ID: 1}, nil
}

func (m *mockDeployKeyQuerier) CreateDeployKey(ctx context.Context, arg db.CreateDeployKeyParams) (db.DeployKey, error) {
	if m.createDeployKeyFn != nil {
		return m.createDeployKeyFn(ctx, arg)
	}
	return db.DeployKey{ID: 1, Title: arg.Title, KeyFingerprint: arg.KeyFingerprint, PublicKey: arg.PublicKey, ReadOnly: arg.ReadOnly, CreatedAt: time.Now()}, nil
}

func (m *mockDeployKeyQuerier) GetDeployKeyByID(ctx context.Context, id int64) (db.DeployKey, error) {
	if m.getDeployKeyByIDFn != nil {
		return m.getDeployKeyByIDFn(ctx, id)
	}
	return db.DeployKey{ID: id, RepositoryID: 1}, nil
}

func (m *mockDeployKeyQuerier) GetDeployKeyByFingerprint(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
	if m.getByFingerprintFn != nil {
		return m.getByFingerprintFn(ctx, arg)
	}
	return db.DeployKey{}, pgx.ErrNoRows
}

func (m *mockDeployKeyQuerier) ListDeployKeysByRepo(ctx context.Context, repositoryID int64) ([]db.DeployKey, error) {
	if m.listDeployKeysFn != nil {
		return m.listDeployKeysFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockDeployKeyQuerier) DeleteDeployKey(ctx context.Context, id int64) error {
	if m.deleteDeployKeyFn != nil {
		return m.deleteDeployKeyFn(ctx, id)
	}
	return nil
}

func TestDeployKeyService_ListDeployKeys(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{
		listDeployKeysFn: func(ctx context.Context, repositoryID int64) ([]db.DeployKey, error) {
			return []db.DeployKey{
				{ID: 1, Title: "ci", KeyFingerprint: "SHA256:abc", PublicKey: "ssh-ed25519 AAAA", ReadOnly: true, CreatedAt: time.Now()},
			}, nil
		},
	})

	keys, err := svc.ListDeployKeys(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Len(t, keys, 1)
	assert.Equal(t, "ci", keys[0].Title)
}

func TestDeployKeyService_ListDeployKeys_RepoNotFound(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	})

	_, err := svc.ListDeployKeys(context.Background(), "alice", "missing")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestDeployKeyService_CreateDeployKey_MissingTitle(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{})
	_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{
		Title: "",
		Key:   "ssh-ed25519 AAAA",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestDeployKeyService_CreateDeployKey_MissingKey(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{})
	_, err := svc.CreateDeployKey(context.Background(), "alice", "demo", CreateDeployKeyRequest{
		Title: "my-key",
		Key:   "",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestDeployKeyService_DeleteDeployKey_InvalidID(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{})
	err := svc.DeleteDeployKey(context.Background(), "alice", "demo", 0)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
}

func TestDeployKeyService_DeleteDeployKey_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewDeployKeyService(&mockDeployKeyQuerier{
		getDeployKeyByIDFn: func(ctx context.Context, id int64) (db.DeployKey, error) {
			return db.DeployKey{}, pgx.ErrNoRows
		},
	})
	err := svc.DeleteDeployKey(context.Background(), "alice", "demo", 999)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestAuthorizedKeyType(t *testing.T) {
	t.Parallel()

	tests := []struct {
		raw      string
		expected string
	}{
		{"ssh-ed25519 AAAA comment", "ssh-ed25519"},
		{"ssh-rsa AAAA", "ssh-rsa"},
		{"ecdsa-sha2-nistp256 AAAA", "ecdsa-sha2-nistp256"},
		{"", "unknown"},
		{"   ", "unknown"},
	}

	for _, tt := range tests {
		result := authorizedKeyType(tt.raw)
		assert.Equal(t, tt.expected, result, "for input: %q", tt.raw)
	}
}
