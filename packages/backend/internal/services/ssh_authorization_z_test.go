package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSSHAuthorization_Z_ErrorBranches(t *testing.T) {
	svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{}, errors.New("lookup failed")
		},
	})
	err := svc.Authorize(context.Background(), 1, "owner", "repo", AccessModeRead)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	orgRepo := db.GetRepoByOwnerAndNameRow{ID: 1, OrgID: pgtype.Int8{Int64: 9, Valid: true}}
	svc = NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return orgRepo, nil
		},
		getHighestTeamPermissionForRepoUser: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", errors.New("team failed")
		},
	})
	err = svc.Authorize(context.Background(), 1, "owner", "repo", AccessModeRead)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	privateRepo := db.GetRepoByOwnerAndNameRow{ID: 1, UserID: pgtype.Int8{Int64: 99, Valid: true}}
	svc = NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return privateRepo, nil
		},
		getCollaboratorPermissionForRepoFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("collab failed")
		},
	})
	err = svc.Authorize(context.Background(), 1, "owner", "repo", AccessModeRead)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
