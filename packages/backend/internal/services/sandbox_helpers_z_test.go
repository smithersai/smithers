package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type sandboxHelpersZTokenStore struct {
	deleted []db.DeleteAccessTokenParams
}

func (s *sandboxHelpersZTokenStore) CreateAccessToken(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
	return db.AccessToken{}, nil
}

func (s *sandboxHelpersZTokenStore) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	s.deleted = append(s.deleted, arg)
	return nil
}

func TestSandboxHelpers_Z_RevokeNilAndNilContextBranches(t *testing.T) {
	revokeTemporaryRepoCloneToken(context.Background(), nil, 7, 1)

	store := &sandboxHelpersZTokenStore{}
	revokeTemporaryRepoCloneToken(nil, store, 7, 0) //nolint:staticcheck // Exercise the supported nil-context fallback.
	assert.Empty(t, store.deleted)

	revokeTemporaryRepoCloneToken(nil, store, 7, 9) //nolint:staticcheck // Exercise the supported nil-context fallback.
	assert.Equal(t, []db.DeleteAccessTokenParams{{ID: 9, UserID: 7}}, store.deleted)
}
