package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockSSHAuthzQuerier struct {
	getRepoByOwnerAndNameFn             func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	isOrgOwnerForRepoUserFn             func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUser func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoFn  func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *mockSSHAuthzQuerier) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	if m.getRepoByOwnerAndNameFn != nil {
		return m.getRepoByOwnerAndNameFn(ctx, arg)
	}
	return db.GetRepoByOwnerAndNameRow{}, pgx.ErrNoRows
}

func (m *mockSSHAuthzQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockSSHAuthzQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUser != nil {
		return m.getHighestTeamPermissionForRepoUser(ctx, arg)
	}
	return "", nil
}

func (m *mockSSHAuthzQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoFn != nil {
		return m.getCollaboratorPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func TestSSHAuthorizationService_Authorize_CollaboratorReadAllowsRead(t *testing.T) {
	svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{
				ID:         1,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			}, nil
		},
		getCollaboratorPermissionForRepoFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
	})

	err := svc.Authorize(context.Background(), 200, "alice", "private-repo", AccessModeRead)
	require.NoError(t, err)
}

func TestSSHAuthorizationService_Authorize_CollaboratorWriteAllowsWrite(t *testing.T) {
	svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{
				ID:         2,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			}, nil
		},
		getCollaboratorPermissionForRepoFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
	})

	err := svc.Authorize(context.Background(), 201, "alice", "private-repo", AccessModeWrite)
	require.NoError(t, err)
}

func TestSSHAuthorizationService_Authorize_CollaboratorReadDeniesWrite(t *testing.T) {
	svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
		getRepoByOwnerAndNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{
				ID:         3,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			}, nil
		},
		getCollaboratorPermissionForRepoFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
	})

	err := svc.Authorize(context.Background(), 202, "alice", "private-repo", AccessModeWrite)
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, apiErr.Status)
}

func TestAccessModeFromGitCommand(t *testing.T) {
	tests := []struct {
		name          string
		command       string
		expectedMode  AccessMode
		expectErr     bool
		expectedCode  int
		expectedError string
	}{
		{
			name:         "upload-pack maps to read",
			command:      "git-upload-pack",
			expectedMode: AccessModeRead,
		},
		{
			name:         "receive-pack maps to write",
			command:      "git-receive-pack",
			expectedMode: AccessModeWrite,
		},
		{
			name:          "unsupported command returns bad request",
			command:       "git-upload-archive",
			expectErr:     true,
			expectedCode:  http.StatusBadRequest,
			expectedError: "unsupported git command",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mode, err := AccessModeFromGitCommand(tc.command)
			if tc.expectErr {
				require.Error(t, err)
				apiErr, ok := err.(*errors.APIError)
				require.True(t, ok)
				assert.Equal(t, tc.expectedCode, apiErr.Status)
				assert.Contains(t, apiErr.Message, tc.expectedError)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.expectedMode, mode)
		})
	}
}

func TestSSHAuthorizationService_Authorize(t *testing.T) {
	tests := []struct {
		name               string
		userID             int64
		owner              string
		repo               string
		mode               AccessMode
		repoRow            db.GetRepoByOwnerAndNameRow
		repoErr            error
		isOrgOwner         bool
		highestTeamPerm    string
		expectedStatusCode int
		expectedMessage    string
	}{
		{
			name:   "repo owner can read",
			userID: 100,
			owner:  "alice",
			repo:   "app",
			mode:   AccessModeRead,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         1,
				UserID:     pgtype.Int8{Int64: 100, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
		},
		{
			name:   "repo owner can write",
			userID: 100,
			owner:  "alice",
			repo:   "app",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         2,
				UserID:     pgtype.Int8{Int64: 100, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
		},
		{
			name:   "org owner can write org repo",
			userID: 101,
			owner:  "acme",
			repo:   "app",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         3,
				OrgID:      pgtype.Int8{Int64: 10, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			isOrgOwner: true,
		},
		{
			name:   "team read can read",
			userID: 102,
			owner:  "acme",
			repo:   "app",
			mode:   AccessModeRead,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         4,
				OrgID:      pgtype.Int8{Int64: 10, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			highestTeamPerm: "read",
		},
		{
			name:   "team read cannot write",
			userID: 102,
			owner:  "acme",
			repo:   "app",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         5,
				OrgID:      pgtype.Int8{Int64: 10, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			highestTeamPerm:    "read",
			expectedStatusCode: http.StatusForbidden,
		},
		{
			name:   "team write can write",
			userID: 103,
			owner:  "acme",
			repo:   "app",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         6,
				OrgID:      pgtype.Int8{Int64: 10, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			highestTeamPerm: "write",
		},
		{
			name:   "team admin can write",
			userID: 104,
			owner:  "acme",
			repo:   "app",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         7,
				OrgID:      pgtype.Int8{Int64: 10, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			highestTeamPerm: "admin",
		},
		{
			name:   "public repo allows read for non-member",
			userID: 105,
			owner:  "alice",
			repo:   "public-repo",
			mode:   AccessModeRead,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         8,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   true,
				IsArchived: false,
			},
		},
		{
			name:   "private repo denies non-member",
			userID: 105,
			owner:  "alice",
			repo:   "private-repo",
			mode:   AccessModeRead,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         9,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   false,
				IsArchived: false,
			},
			expectedStatusCode: http.StatusForbidden,
		},
		{
			name:   "archived repo denies writes",
			userID: 100,
			owner:  "alice",
			repo:   "archived",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         10,
				UserID:     pgtype.Int8{Int64: 100, Valid: true},
				IsPublic:   true,
				IsArchived: true,
			},
			expectedStatusCode: http.StatusForbidden,
		},
		{
			name:   "archived repo still allows read when otherwise authorized",
			userID: 100,
			owner:  "alice",
			repo:   "archived",
			mode:   AccessModeRead,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         11,
				UserID:     pgtype.Int8{Int64: 100, Valid: true},
				IsPublic:   true,
				IsArchived: true,
			},
		},
		{
			name:               "repo not found returns not found",
			userID:             100,
			owner:              "missing",
			repo:               "repo",
			mode:               AccessModeRead,
			repoErr:            pgx.ErrNoRows,
			expectedStatusCode: http.StatusNotFound,
		},
		{
			name:   "archived private repo hides archive reason from unauthorized writer",
			userID: 105,
			owner:  "alice",
			repo:   "archived-private",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         12,
				UserID:     pgtype.Int8{Int64: 999, Valid: true},
				IsPublic:   false,
				IsArchived: true,
			},
			expectedStatusCode: http.StatusForbidden,
			expectedMessage:    "permission denied",
		},
		{
			name:   "archived private repo reports archive reason to authorized writer",
			userID: 100,
			owner:  "alice",
			repo:   "archived-private",
			mode:   AccessModeWrite,
			repoRow: db.GetRepoByOwnerAndNameRow{
				ID:         13,
				UserID:     pgtype.Int8{Int64: 100, Valid: true},
				IsPublic:   false,
				IsArchived: true,
			},
			expectedStatusCode: http.StatusForbidden,
			expectedMessage:    "repository is archived",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
				getRepoByOwnerAndNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return tc.repoRow, tc.repoErr
				},
				isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return tc.isOrgOwner, nil
				},
				getHighestTeamPermissionForRepoUser: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.highestTeamPerm, nil
				},
			})

			err := svc.Authorize(context.Background(), tc.userID, tc.owner, tc.repo, tc.mode)
			if tc.expectedStatusCode == 0 {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			apiErr, ok := err.(*errors.APIError)
			require.True(t, ok)
			assert.Equal(t, tc.expectedStatusCode, apiErr.Status)
			if tc.expectedMessage != "" {
				assert.Equal(t, tc.expectedMessage, apiErr.Message)
			}
		})
	}
}
