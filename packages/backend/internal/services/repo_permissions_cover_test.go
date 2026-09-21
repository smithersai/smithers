package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestRepoPermissions_Cov_CanReadWriteAdminOwnAndExportedBranches(t *testing.T) {
	ctx := context.Background()
	ownerRepo := db.Repository{ID: 1, IsPublic: false, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	q := &permissionQuerier{}

	readable, err := canReadRepo(ctx, q, ownerRepo, 7)
	require.NoError(t, err)
	assert.True(t, readable)

	writable, err := canWriteRepo(ctx, q, ownerRepo, 7)
	require.NoError(t, err)
	assert.True(t, writable)

	admin, err := CanAdminRepo(ctx, q, ownerRepo, 7)
	require.NoError(t, err)
	assert.True(t, admin)

	owner, err := canOwnRepo(ctx, q, ownerRepo, 7)
	require.NoError(t, err)
	assert.True(t, owner)

	publicReadable, err := canReadRepo(ctx, q, db.Repository{ID: 2, IsPublic: true}, 0)
	require.NoError(t, err)
	assert.True(t, publicReadable)

	collabQ := &permissionQuerier{
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
	}
	permission, isOwner, err := repoPermissionForUser(ctx, collabQ, db.Repository{ID: 3}, 8)
	require.NoError(t, err)
	assert.False(t, isOwner)
	assert.Equal(t, "write", permission)

	admin, err = canAdminRepo(ctx, collabQ, db.Repository{ID: 3}, 8)
	require.NoError(t, err)
	assert.False(t, admin)
}

func TestRepoPermissions_Cov_OrgOwnerTeamAndErrorBranches(t *testing.T) {
	ctx := context.Background()
	orgRepo := db.Repository{ID: 44, OrgID: pgtype.Int8{Int64: 5, Valid: true}}

	orgOwnerQ := &permissionQuerier{
		isOrgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return true, nil
		},
	}
	permission, isOwner, err := repoPermissionForUser(ctx, orgOwnerQ, orgRepo, 9)
	require.NoError(t, err)
	assert.True(t, isOwner)
	assert.Empty(t, permission)

	teamQ := &permissionQuerier{
		isOrgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		highestTeamPermFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "admin", nil
		},
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
	}
	admin, err := canAdminRepo(ctx, teamQ, orgRepo, 9)
	require.NoError(t, err)
	assert.True(t, admin)

	errQ := &permissionQuerier{
		isOrgOwnerFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, assert.AnError
		},
	}
	_, _, err = repoPermissionForUser(ctx, errQ, orgRepo, 9)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)

	errQ = &permissionQuerier{
		collabPermFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", assert.AnError
		},
	}
	_, err = canWriteRepo(ctx, errQ, db.Repository{ID: 45}, 9)
	require.Error(t, err)
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
}

// permissionQuerier isolates shared authorization tests from feature-specific stores.
type permissionQuerier struct {
	isOrgOwnerFn      func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error)
	highestTeamPermFn func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collabPermFn      func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *permissionQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerFn != nil {
		return m.isOrgOwnerFn(ctx, arg)
	}
	return false, nil
}
func (m *permissionQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.highestTeamPermFn != nil {
		return m.highestTeamPermFn(ctx, arg)
	}
	return "", nil
}
func (m *permissionQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermFn != nil {
		return m.collabPermFn(ctx, arg)
	}
	return "", nil
}
