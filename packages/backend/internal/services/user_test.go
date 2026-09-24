package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockUserQuerier struct {
	getUserByIDFn                 func(ctx context.Context, id int64) (db.User, error)
	getUserByLowerUsername        func(ctx context.Context, lowerUsername string) (db.User, error)
	getOrgByIDFn                  func(ctx context.Context, id int64) (db.Organization, error)
	updateUserFn                  func(ctx context.Context, arg db.UpdateUserParams) (db.User, error)
	listUserReposFn               func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error)
	listDefaultBookmarkHeadsFn    func(ctx context.Context, repositoryIDs []int64) ([]db.ListDefaultBookmarkHeadsByRepoIDsRow, error)
	countUserReposFn              func(ctx context.Context, userID pgtype.Int8) (int64, error)
	listPublicUserReposFn         func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error)
	countPublicUserReposFn        func(ctx context.Context, userID pgtype.Int8) (int64, error)
	listUserOrgsFn                func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error)
	countUserOrgsFn               func(ctx context.Context, userID int64) (int64, error)
	listUserStarredReposFn        func(ctx context.Context, arg db.ListUserStarredReposParams) ([]db.Repository, error)
	countUserStarredReposFn       func(ctx context.Context, userID int64) (int64, error)
	listPublicUserStarredReposFn  func(ctx context.Context, arg db.ListPublicUserStarredReposParams) ([]db.Repository, error)
	countPublicUserStarredReposFn func(ctx context.Context, userID int64) (int64, error)
	listPublicAuditLogsByActorFn  func(ctx context.Context, arg db.ListPublicAuditLogsByActorParams) ([]db.AuditLog, error)
	countPublicAuditLogsByActorFn func(ctx context.Context, arg db.CountPublicAuditLogsByActorParams) (int64, error)
	listReadableReposForUserFn    func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error)
	countReadableReposForUserFn   func(ctx context.Context, userID int64) (int64, error)
	isOrgOwnerForRepoUserFn       func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	highestTeamPermissionFn       func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	collaboratorPermissionFn      func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *mockUserQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockUserQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.highestTeamPermissionFn != nil {
		return m.highestTeamPermissionFn(ctx, arg)
	}
	return "", nil
}

func (m *mockUserQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collaboratorPermissionFn != nil {
		return m.collaboratorPermissionFn(ctx, arg)
	}
	return "", nil
}

func (m *mockUserQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	return m.getUserByIDFn(ctx, id)
}

func (m *mockUserQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	return m.getUserByLowerUsername(ctx, lowerUsername)
}

func (m *mockUserQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	return m.getOrgByIDFn(ctx, id)
}

func (m *mockUserQuerier) UpdateUser(ctx context.Context, arg db.UpdateUserParams) (db.User, error) {
	return m.updateUserFn(ctx, arg)
}

func (m *mockUserQuerier) ListUserRepos(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
	return m.listUserReposFn(ctx, arg)
}

func (m *mockUserQuerier) ListDefaultBookmarkHeadsByRepoIDs(ctx context.Context, repositoryIDs []int64) ([]db.ListDefaultBookmarkHeadsByRepoIDsRow, error) {
	if m.listDefaultBookmarkHeadsFn != nil {
		return m.listDefaultBookmarkHeadsFn(ctx, repositoryIDs)
	}
	return nil, nil
}

func (m *mockUserQuerier) CountUserRepos(ctx context.Context, userID pgtype.Int8) (int64, error) {
	return m.countUserReposFn(ctx, userID)
}

func (m *mockUserQuerier) ListReadableReposForUser(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
	if m.listReadableReposForUserFn != nil {
		return m.listReadableReposForUserFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockUserQuerier) CountReadableReposForUser(ctx context.Context, userID int64) (int64, error) {
	if m.countReadableReposForUserFn != nil {
		return m.countReadableReposForUserFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockUserQuerier) ListPublicUserRepos(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
	return m.listPublicUserReposFn(ctx, arg)
}

func (m *mockUserQuerier) CountPublicUserRepos(ctx context.Context, userID pgtype.Int8) (int64, error) {
	return m.countPublicUserReposFn(ctx, userID)
}

func (m *mockUserQuerier) ListUserOrgs(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
	return m.listUserOrgsFn(ctx, arg)
}

func (m *mockUserQuerier) CountUserOrgs(ctx context.Context, userID int64) (int64, error) {
	return m.countUserOrgsFn(ctx, userID)
}

func (m *mockUserQuerier) ListUserStarredRepos(ctx context.Context, arg db.ListUserStarredReposParams) ([]db.Repository, error) {
	return m.listUserStarredReposFn(ctx, arg)
}

func (m *mockUserQuerier) CountUserStarredRepos(ctx context.Context, userID int64) (int64, error) {
	return m.countUserStarredReposFn(ctx, userID)
}

func (m *mockUserQuerier) ListPublicUserStarredRepos(ctx context.Context, arg db.ListPublicUserStarredReposParams) ([]db.Repository, error) {
	return m.listPublicUserStarredReposFn(ctx, arg)
}

func (m *mockUserQuerier) CountPublicUserStarredRepos(ctx context.Context, userID int64) (int64, error) {
	return m.countPublicUserStarredReposFn(ctx, userID)
}

func (m *mockUserQuerier) ListPublicAuditLogsByActor(ctx context.Context, arg db.ListPublicAuditLogsByActorParams) ([]db.AuditLog, error) {
	return m.listPublicAuditLogsByActorFn(ctx, arg)
}

func (m *mockUserQuerier) CountPublicAuditLogsByActor(ctx context.Context, arg db.CountPublicAuditLogsByActorParams) (int64, error) {
	return m.countPublicAuditLogsByActorFn(ctx, arg)
}

func (m *mockUserQuerier) GetUserNotificationPreferences(_ context.Context, _ int64) (db.GetUserNotificationPreferencesRow, error) {
	return db.GetUserNotificationPreferencesRow{EmailNotificationsEnabled: true}, nil
}

func (m *mockUserQuerier) UpdateUserNotificationPreferences(_ context.Context, _ db.UpdateUserNotificationPreferencesParams) (db.User, error) {
	return db.User{}, nil
}

func (m *mockUserQuerier) ListUserOAuthAccounts(_ context.Context, _ int64) ([]db.OauthAccount, error) {
	return nil, nil
}

func (m *mockUserQuerier) DeleteOAuthAccount(_ context.Context, _ db.DeleteOAuthAccountParams) error {
	return nil
}

func (m *mockUserQuerier) DeleteGitHubSyncedRepoReadGrantsForUser(context.Context, int64) error {
	return nil
}

func mustAPIErrorStatus(t *testing.T, err error) int {
	t.Helper()

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected APIError")
	return apiErr.Status
}

func testDBUser() db.User {
	now := time.Now().UTC().Truncate(time.Second)
	return db.User{
		ID:            42,
		Username:      "alice",
		LowerUsername: "alice",
		DisplayName:   "Alice",
		Bio:           "Engineer",
		AvatarUrl:     "https://example.com/avatar.png",
		Email:         pgtype.Text{String: "alice@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "alice@example.com", Valid: true},
		IsActive:      true,
		IsAdmin:       true,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}

func TestUserService_GetAuthenticatedUser(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		query         *mockUserQuerier
		expectedError int
	}{
		{
			name: "success",
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					assert.Equal(t, int64(42), id)
					return testDBUser(), nil
				},
			},
		},
		{
			name: "not found",
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{}, pgx.ErrNoRows
				},
			},
			expectedError: 404,
		},
		{
			name: "db failure",
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{}, errors.New("boom")
				},
			},
			expectedError: 500,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewUserService(tc.query)

			profile, err := svc.GetAuthenticatedUser(context.Background(), 42)
			if tc.expectedError != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.expectedError, mustAPIErrorStatus(t, err))
				return
			}

			require.NoError(t, err)
			assert.Equal(t, int64(42), profile.ID)
			assert.Equal(t, "alice", profile.Username)
			assert.Equal(t, "alice@example.com", profile.Email)
		})
	}
}

func TestUserService_GetUserByUsername(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		username      string
		query         *mockUserQuerier
		expectedError int
	}{
		{
			name:     "success returns PublicUserProfile with only public fields",
			username: "Alice",
			query: &mockUserQuerier{
				getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
					assert.Equal(t, "alice", lowerUsername)
					return testDBUser(), nil
				},
			},
		},
		{
			name:          "empty username",
			username:      "   ",
			query:         &mockUserQuerier{},
			expectedError: 400,
		},
		{
			name:     "user not found",
			username: "ghost",
			query: &mockUserQuerier{
				getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
					return db.User{}, pgx.ErrNoRows
				},
			},
			expectedError: 404,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewUserService(tc.query)

			profile, err := svc.GetUserByUsername(context.Background(), tc.username)
			if tc.expectedError != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.expectedError, mustAPIErrorStatus(t, err))
				return
			}

			require.NoError(t, err)

			// Verify the return type is PublicUserProfile (compile-time check)
			var _ PublicUserProfile = profile

			// Verify public fields are populated
			assert.Equal(t, int64(42), profile.ID)
			assert.Equal(t, "alice", profile.Username)
			assert.Equal(t, "Alice", profile.DisplayName)
			assert.Equal(t, "Engineer", profile.Bio)
			assert.Equal(t, "https://example.com/avatar.png", profile.AvatarURL)
			assert.False(t, profile.CreatedAt.IsZero())
			assert.False(t, profile.UpdatedAt.IsZero())
		})
	}
}

func TestMapPublicUserProfile(t *testing.T) {
	t.Parallel()

	dbUser := testDBUser()
	// Ensure the test user has sensitive fields populated
	dbUser.Email = pgtype.Text{String: "alice@example.com", Valid: true}
	dbUser.LowerEmail = pgtype.Text{String: "alice@example.com", Valid: true}
	dbUser.LowerUsername = "alice"
	dbUser.IsAdmin = true
	dbUser.WalletAddress = pgtype.Text{String: "0xdeadbeef", Valid: true}

	pub := mapPublicUserProfile(dbUser)

	// Verify whitelisted public fields
	assert.Equal(t, int64(42), pub.ID)
	assert.Equal(t, "alice", pub.Username)
	assert.Equal(t, "Alice", pub.DisplayName)
	assert.Equal(t, "Engineer", pub.Bio)
	assert.Equal(t, "https://example.com/avatar.png", pub.AvatarURL)
	assert.False(t, pub.CreatedAt.IsZero())
	assert.False(t, pub.UpdatedAt.IsZero())

	// Verify PublicUserProfile struct does NOT have sensitive fields
	// This is a compile-time/structural guarantee: the struct simply lacks these fields.
	// We use JSON marshaling to assert no sensitive keys appear in serialized output.
	data, err := json.Marshal(pub)
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(data, &raw))

	sensitiveKeys := []string{"email", "lower_username", "lower_email", "is_admin", "wallet_address", "is_active", "prohibit_login", "last_login_at", "user_type", "search_vector"}
	for _, key := range sensitiveKeys {
		_, exists := raw[key]
		assert.False(t, exists, "public profile JSON must not contain key %q", key)
	}
}

func TestUserService_UpdateAuthenticatedUser(t *testing.T) {
	t.Parallel()

	displayName := "Alice Updated"
	bio := "Updated bio"
	avatarURL := "https://cdn.example.com/avatar.png"

	tests := []struct {
		name          string
		req           UpdateUserRequest
		query         *mockUserQuerier
		expectedError int
	}{
		{
			name: "success",
			req: UpdateUserRequest{
				DisplayName: &displayName,
				Bio:         &bio,
				AvatarURL:   &avatarURL,
			},
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return testDBUser(), nil
				},
				updateUserFn: func(ctx context.Context, arg db.UpdateUserParams) (db.User, error) {
					assert.Equal(t, int64(42), arg.UserID)
					assert.Equal(t, displayName, arg.DisplayName)
					assert.Equal(t, bio, arg.Bio)
					assert.Equal(t, avatarURL, arg.AvatarUrl)
					assert.Equal(t, pgtype.Text{String: "alice@example.com", Valid: true}, arg.Email)
					assert.Equal(t, pgtype.Text{String: "alice@example.com", Valid: true}, arg.LowerEmail)

					updated := testDBUser()
					updated.DisplayName = displayName
					updated.Bio = bio
					updated.AvatarUrl = avatarURL
					updated.Email = arg.Email
					updated.LowerEmail = arg.LowerEmail
					return updated, nil
				},
			},
		},
		{
			name: "invalid avatar url",
			req:  UpdateUserRequest{AvatarURL: strPtr("not-a-url")},
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return testDBUser(), nil
				},
				updateUserFn: func(ctx context.Context, arg db.UpdateUserParams) (db.User, error) {
					t.Fatal("update should not run")
					return db.User{}, nil
				},
			},
			expectedError: 422,
		},
		{
			name: "user not found",
			req:  UpdateUserRequest{},
			query: &mockUserQuerier{
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{}, pgx.ErrNoRows
				},
			},
			expectedError: 404,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewUserService(tc.query)

			profile, err := svc.UpdateAuthenticatedUser(context.Background(), 42, tc.req)
			if tc.expectedError != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.expectedError, mustAPIErrorStatus(t, err))
				return
			}

			require.NoError(t, err)
			assert.Equal(t, "Alice Updated", profile.DisplayName)
			// Email should remain unchanged (original from testDBUser)
			assert.Equal(t, "alice@example.com", profile.Email)
		})
	}
}

func TestUserService_UpdateAuthenticatedUser_EmailIgnored(t *testing.T) {
	t.Parallel()

	email := "attacker@example.com"
	displayName := "Alice Updated"
	current := testDBUser()

	svc := NewUserService(&mockUserQuerier{
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return current, nil
		},
		updateUserFn: func(ctx context.Context, arg db.UpdateUserParams) (db.User, error) {
			assert.Equal(t, current.Email, arg.Email, "email should preserve the current database value")
			assert.Equal(t, current.LowerEmail, arg.LowerEmail, "lower_email should preserve the current database value")

			updated := testDBUser()
			updated.DisplayName = displayName
			updated.Email = arg.Email
			updated.LowerEmail = arg.LowerEmail
			return updated, nil
		},
	})

	profile, err := svc.UpdateAuthenticatedUser(context.Background(), 42, UpdateUserRequest{
		DisplayName: &displayName,
		Email:       &email,
	})

	require.NoError(t, err)
	assert.Equal(t, displayName, profile.DisplayName)
	// Email should remain unchanged
	assert.Equal(t, "alice@example.com", profile.Email)
}

func TestUserService_ListAuthenticatedUserRepos(t *testing.T) {
	t.Parallel()

	t.Run("defaults", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				assert.Equal(t, int64(42), id)
				return testDBUser(), nil
			},
			countUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				assert.Equal(t, pgtype.Int8{Int64: 42, Valid: true}, userID)
				return 1, nil
			},
			listUserReposFn: func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.Repository{{ID: 9, Name: "repo-a", Description: "desc", IsPublic: true, DefaultBookmark: "main"}}, nil
			},
			listDefaultBookmarkHeadsFn: func(ctx context.Context, repositoryIDs []int64) ([]db.ListDefaultBookmarkHeadsByRepoIDsRow, error) {
				assert.Equal(t, []int64{9}, repositoryIDs)
				return []db.ListDefaultBookmarkHeadsByRepoIDsRow{{
					RepositoryID: 9,
					ChangeID:     "change-main",
					CommitID:     "commit-main",
				}}, nil
			},
		})

		result, err := svc.ListAuthenticatedUserRepos(context.Background(), 42, 0, 0)
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		assert.Equal(t, 1, result.Page)
		assert.Equal(t, 30, result.PerPage)
		require.Len(t, result.Items, 1)
		assert.Equal(t, int64(9), result.Items[0].ID)
		assert.Equal(t, "alice", result.Items[0].Owner)
		assert.Equal(t, "user", result.Items[0].OwnerType)
		assert.Equal(t, "alice/repo-a", result.Items[0].FullName)
		assert.Equal(t, DefaultBookmarkHead{ChangeID: "change-main", CommitID: "commit-main"}, result.Items[0].DefaultBookmarkHead)
	})

	t.Run("clamps per page to max", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return testDBUser(), nil
			},
			countUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 0, nil
			},
			listUserReposFn: func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
				assert.Equal(t, int32(100), arg.PageSize)
				assert.Equal(t, int32(100), arg.PageOffset)
				return nil, nil
			},
		})

		result, err := svc.ListAuthenticatedUserRepos(context.Background(), 42, 2, 500)
		require.NoError(t, err)
		assert.Equal(t, 2, result.Page)
		assert.Equal(t, 100, result.PerPage)
	})

	t.Run("count failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return testDBUser(), nil
			},
			countUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 0, errors.New("count failed")
			},
			listUserReposFn: func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.ListAuthenticatedUserRepos(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("user lookup failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		})

		_, err := svc.ListAuthenticatedUserRepos(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 404, mustAPIErrorStatus(t, err))
	})

	t.Run("default bookmark head lookup failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return testDBUser(), nil
			},
			countUserReposFn: func(context.Context, pgtype.Int8) (int64, error) {
				return 1, nil
			},
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
				return []db.Repository{{ID: 9}}, nil
			},
			listDefaultBookmarkHeadsFn: func(context.Context, []int64) ([]db.ListDefaultBookmarkHeadsByRepoIDsRow, error) {
				return nil, errors.New("head lookup failed")
			},
		})

		_, err := svc.ListAuthenticatedUserRepos(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}

func TestMapRepoSummary_OwnerType(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "user", mapRepoSummary(db.Repository{
		UserID: pgtype.Int8{Int64: 1, Valid: true},
	}, "alice").OwnerType)
	assert.Equal(t, "organization", mapRepoSummary(db.Repository{
		OrgID: pgtype.Int8{Int64: 2, Valid: true},
	}, "acme").OwnerType)
}

func TestUserService_ListReadableReposForAuthenticatedUser(t *testing.T) {
	t.Parallel()

	t.Run("defaults and row mapping", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			listReadableReposForUserFn: func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
				assert.Equal(t, int64(42), arg.UserID)
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.ListReadableReposForUserRow{
					{ID: 10, Owner: "alice", Name: "demo"},
					{ID: 11, Owner: "acme", Name: "tools"},
				}, nil
			},
			countReadableReposForUserFn: func(ctx context.Context, userID int64) (int64, error) {
				assert.Equal(t, int64(42), userID)
				return 2, nil
			},
		})

		result, err := svc.ListReadableReposForAuthenticatedUser(context.Background(), 42, 0, 0)
		require.NoError(t, err)
		assert.Equal(t, 1, result.Page)
		assert.Equal(t, 30, result.PerPage)
		assert.Equal(t, int64(2), result.TotalCount)
		require.Len(t, result.Items, 2)
		assert.Equal(t, ReadableRepoRow{ID: 10, Owner: "alice", Name: "demo"}, result.Items[0])
		assert.Equal(t, ReadableRepoRow{ID: 11, Owner: "acme", Name: "tools"}, result.Items[1])
	})

	t.Run("clamps limit to 200", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			listReadableReposForUserFn: func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
				assert.Equal(t, int32(MaxReadableReposPerPage), arg.PageSize)
				assert.Equal(t, int32(MaxReadableReposPerPage), arg.PageOffset)
				return nil, nil
			},
			countReadableReposForUserFn: func(ctx context.Context, userID int64) (int64, error) {
				return 0, nil
			},
		})

		result, err := svc.ListReadableReposForAuthenticatedUser(context.Background(), 42, 2, 999)
		require.NoError(t, err)
		assert.Equal(t, 2, result.Page)
		assert.Equal(t, MaxReadableReposPerPage, result.PerPage)
	})

	t.Run("list failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			listReadableReposForUserFn: func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
				return nil, errors.New("list failed")
			},
		})

		_, err := svc.ListReadableReposForAuthenticatedUser(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("count failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			listReadableReposForUserFn: func(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error) {
				return []db.ListReadableReposForUserRow{{ID: 10, Owner: "alice", Name: "demo"}}, nil
			},
			countReadableReposForUserFn: func(ctx context.Context, userID int64) (int64, error) {
				return 0, errors.New("count failed")
			},
		})

		_, err := svc.ListReadableReposForAuthenticatedUser(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}

func TestUserService_ListAuthenticatedUserOrgs(t *testing.T) {
	t.Parallel()

	t.Run("defaults", func(t *testing.T) {
		countCalled := false
		svc := NewUserService(&mockUserQuerier{
			countUserOrgsFn: func(ctx context.Context, userID int64) (int64, error) {
				countCalled = true
				assert.Equal(t, int64(42), userID)
				return 1, nil
			},
			listUserOrgsFn: func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.Organization{{ID: 3, Name: "acme", Visibility: "public"}}, nil
			},
		})

		result, err := svc.ListAuthenticatedUserOrgs(context.Background(), 42, 0, 0)
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		assert.Equal(t, 1, result.Page)
		assert.Equal(t, 30, result.PerPage)
		require.Len(t, result.Items, 1)
		assert.Equal(t, int64(3), result.Items[0].ID)
		assert.True(t, countCalled)
	})

	t.Run("uses total count for pagination metadata", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			countUserOrgsFn: func(ctx context.Context, userID int64) (int64, error) {
				assert.Equal(t, int64(42), userID)
				return 5, nil
			},
			listUserOrgsFn: func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
				assert.Equal(t, int32(1), arg.PageSize)
				assert.Equal(t, int32(1), arg.PageOffset)
				return []db.Organization{{ID: 3, Name: "acme", Visibility: "public"}}, nil
			},
		})

		result, err := svc.ListAuthenticatedUserOrgs(context.Background(), 42, 2, 1)
		require.NoError(t, err)
		assert.Equal(t, int64(5), result.TotalCount)
		require.Len(t, result.Items, 1)
	})

	t.Run("list failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			countUserOrgsFn: func(ctx context.Context, userID int64) (int64, error) {
				return 2, nil
			},
			listUserOrgsFn: func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
				return nil, errors.New("list failed")
			},
		})

		_, err := svc.ListAuthenticatedUserOrgs(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("count failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			countUserOrgsFn: func(ctx context.Context, userID int64) (int64, error) {
				return 0, errors.New("count failed")
			},
			listUserOrgsFn: func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.ListAuthenticatedUserOrgs(context.Background(), 42, 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}

func TestUserService_ListUserReposByUsername(t *testing.T) {
	t.Parallel()

	t.Run("defaults and lookup", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				assert.Equal(t, "alice", lowerUsername)
				return testDBUser(), nil
			},
			countPublicUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				assert.Equal(t, pgtype.Int8{Int64: 42, Valid: true}, userID)
				return 2, nil
			},
			listPublicUserReposFn: func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
				assert.Equal(t, pgtype.Int8{Int64: 42, Valid: true}, arg.UserID)
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.Repository{
					{ID: 9, Name: "repo-a", Description: "desc", IsPublic: true, DefaultBookmark: "main"},
					{ID: 10, Name: "repo-b", Description: "desc2", IsPublic: true, DefaultBookmark: "main"},
				}, nil
			},
		})

		result, err := svc.ListUserReposByUsername(context.Background(), "Alice", 0, 0)
		require.NoError(t, err)
		assert.Equal(t, int64(2), result.TotalCount)
		assert.Equal(t, 1, result.Page)
		assert.Equal(t, 30, result.PerPage)
		require.Len(t, result.Items, 2)
		assert.Equal(t, int64(9), result.Items[0].ID)
		assert.Equal(t, int64(10), result.Items[1].ID)
	})

	t.Run("per page capped at 100", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return testDBUser(), nil
			},
			countPublicUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 0, nil
			},
			listPublicUserReposFn: func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
				assert.Equal(t, int32(100), arg.PageSize)
				assert.Equal(t, int32(100), arg.PageOffset)
				return nil, nil
			},
		})

		result, err := svc.ListUserReposByUsername(context.Background(), "alice", 2, 500)
		require.NoError(t, err)
		assert.Equal(t, 2, result.Page)
		assert.Equal(t, 100, result.PerPage)
	})

	t.Run("user not found", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
		})

		_, err := svc.ListUserReposByUsername(context.Background(), "ghost", 1, 30)
		require.Error(t, err)
		assert.Equal(t, 404, mustAPIErrorStatus(t, err))
	})

	t.Run("empty username returns 400", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{})

		_, err := svc.ListUserReposByUsername(context.Background(), "  ", 1, 30)
		require.Error(t, err)
		assert.Equal(t, 400, mustAPIErrorStatus(t, err))
	})

	t.Run("count query failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return testDBUser(), nil
			},
			countPublicUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 0, errors.New("count failed")
			},
			listPublicUserReposFn: func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.ListUserReposByUsername(context.Background(), "alice", 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("list query failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return testDBUser(), nil
			},
			countPublicUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 2, nil
			},
			listPublicUserReposFn: func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
				return nil, errors.New("list failed")
			},
		})

		_, err := svc.ListUserReposByUsername(context.Background(), "alice", 1, 20)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("only public repos returned", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return testDBUser(), nil
			},
			countPublicUserReposFn: func(ctx context.Context, userID pgtype.Int8) (int64, error) {
				return 1, nil
			},
			listPublicUserReposFn: func(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error) {
				return []db.Repository{
					{ID: 9, Name: "public-repo", IsPublic: true, DefaultBookmark: "main"},
				}, nil
			},
		})

		result, err := svc.ListUserReposByUsername(context.Background(), "alice", 1, 30)
		require.NoError(t, err)
		require.Len(t, result.Items, 1)
		assert.True(t, result.Items[0].IsPublic)
	})
}

func TestUserService_ListUserActivityByUsername(t *testing.T) {
	t.Parallel()

	t.Run("maps public repo audit logs into activity summaries", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				assert.Equal(t, "alice", lowerUsername)
				return testDBUser(), nil
			},
			countPublicAuditLogsByActorFn: func(ctx context.Context, arg db.CountPublicAuditLogsByActorParams) (int64, error) {
				assert.Equal(t, pgtype.Int8{Int64: 42, Valid: true}, arg.ActorID)
				return 1, nil
			},
			listPublicAuditLogsByActorFn: func(ctx context.Context, arg db.ListPublicAuditLogsByActorParams) ([]db.AuditLog, error) {
				assert.Equal(t, int32(30), arg.PageLimit)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.AuditLog{{
					ID:         9,
					EventType:  "repo.create",
					ActorName:  "alice",
					TargetType: "repository",
					TargetName: "alice/demo",
					Action:     "create",
					CreatedAt:  now,
				}}, nil
			},
		})

		result, err := svc.ListUserActivityByUsername(context.Background(), "Alice", 0, 0)
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		require.Len(t, result.Items, 1)
		assert.Equal(t, "alice", result.Items[0].ActorUsername)
		assert.Equal(t, "created repository alice/demo", result.Items[0].Summary)
		assert.Equal(t, now, result.Items[0].CreatedAt)
	})

	t.Run("count failure", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByLowerUsername: func(ctx context.Context, lowerUsername string) (db.User, error) {
				return testDBUser(), nil
			},
			countPublicAuditLogsByActorFn: func(ctx context.Context, arg db.CountPublicAuditLogsByActorParams) (int64, error) {
				return 0, errors.New("boom")
			},
		})

		_, err := svc.ListUserActivityByUsername(context.Background(), "alice", 1, 30)
		require.Error(t, err)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}

func strPtr(v string) *string {
	return &v
}
