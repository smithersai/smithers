package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type userCovQuerier struct {
	*mockUserQuerier

	getPrefsFn     func(ctx context.Context, userID int64) (db.GetUserNotificationPreferencesRow, error)
	updatePrefsFn  func(ctx context.Context, arg db.UpdateUserNotificationPreferencesParams) (db.User, error)
	listAccountsFn func(ctx context.Context, userID int64) ([]db.OauthAccount, error)
	deleteAcctFn   func(ctx context.Context, arg db.DeleteOAuthAccountParams) error
}

func (q *userCovQuerier) GetUserNotificationPreferences(ctx context.Context, userID int64) (db.GetUserNotificationPreferencesRow, error) {
	if q.getPrefsFn != nil {
		return q.getPrefsFn(ctx, userID)
	}
	return db.GetUserNotificationPreferencesRow{ID: userID, EmailNotificationsEnabled: true}, nil
}

func (q *userCovQuerier) UpdateUserNotificationPreferences(ctx context.Context, arg db.UpdateUserNotificationPreferencesParams) (db.User, error) {
	if q.updatePrefsFn != nil {
		return q.updatePrefsFn(ctx, arg)
	}
	return db.User{ID: arg.UserID, EmailNotificationsEnabled: arg.EmailNotificationsEnabled}, nil
}

func (q *userCovQuerier) ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error) {
	if q.listAccountsFn != nil {
		return q.listAccountsFn(ctx, userID)
	}
	return nil, nil
}

func (q *userCovQuerier) DeleteOAuthAccount(ctx context.Context, arg db.DeleteOAuthAccountParams) error {
	if q.deleteAcctFn != nil {
		return q.deleteAcctFn(ctx, arg)
	}
	return nil
}

func TestUser_Cov_NotificationPreferencesAndConnectedAccounts(t *testing.T) {
	ctx := context.Background()

	t.Run("loads preferences", func(t *testing.T) {
		svc := NewUserService(&userCovQuerier{
			getPrefsFn: func(_ context.Context, userID int64) (db.GetUserNotificationPreferencesRow, error) {
				require.Equal(t, int64(42), userID)
				return db.GetUserNotificationPreferencesRow{ID: userID, EmailNotificationsEnabled: false}, nil
			},
		})

		prefs, err := svc.GetNotificationPreferences(ctx, 42)
		require.NoError(t, err)
		assert.False(t, prefs.EmailNotificationsEnabled)
	})

	t.Run("maps missing and failing preference loads", func(t *testing.T) {
		svc := NewUserService(&userCovQuerier{
			getPrefsFn: func(context.Context, int64) (db.GetUserNotificationPreferencesRow, error) {
				return db.GetUserNotificationPreferencesRow{}, pgx.ErrNoRows
			},
		})
		_, err := svc.GetNotificationPreferences(ctx, 99)
		assert.Equal(t, 404, mustAPIErrorStatus(t, err))

		svc = NewUserService(&userCovQuerier{
			getPrefsFn: func(context.Context, int64) (db.GetUserNotificationPreferencesRow, error) {
				return db.GetUserNotificationPreferencesRow{}, errors.New("db offline")
			},
		})
		_, err = svc.GetNotificationPreferences(ctx, 99)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("updates preferences with explicit and preserved values", func(t *testing.T) {
		var updates []db.UpdateUserNotificationPreferencesParams
		svc := NewUserService(&userCovQuerier{
			getPrefsFn: func(context.Context, int64) (db.GetUserNotificationPreferencesRow, error) {
				return db.GetUserNotificationPreferencesRow{ID: 7, EmailNotificationsEnabled: true}, nil
			},
			updatePrefsFn: func(_ context.Context, arg db.UpdateUserNotificationPreferencesParams) (db.User, error) {
				updates = append(updates, arg)
				return db.User{ID: arg.UserID, EmailNotificationsEnabled: arg.EmailNotificationsEnabled}, nil
			},
		})

		prefs, err := svc.UpdateNotificationPreferences(ctx, 7, UpdateNotificationPreferencesRequest{})
		require.NoError(t, err)
		assert.True(t, prefs.EmailNotificationsEnabled)

		disabled := false
		prefs, err = svc.UpdateNotificationPreferences(ctx, 7, UpdateNotificationPreferencesRequest{EmailNotificationsEnabled: &disabled})
		require.NoError(t, err)
		assert.False(t, prefs.EmailNotificationsEnabled)
		require.Len(t, updates, 2)
		assert.True(t, updates[0].EmailNotificationsEnabled)
		assert.False(t, updates[1].EmailNotificationsEnabled)
	})

	t.Run("surfaces update failures", func(t *testing.T) {
		svc := NewUserService(&userCovQuerier{
			getPrefsFn: func(context.Context, int64) (db.GetUserNotificationPreferencesRow, error) {
				return db.GetUserNotificationPreferencesRow{ID: 7, EmailNotificationsEnabled: true}, nil
			},
			updatePrefsFn: func(context.Context, db.UpdateUserNotificationPreferencesParams) (db.User, error) {
				return db.User{}, errors.New("write failed")
			},
		})
		_, err := svc.UpdateNotificationPreferences(ctx, 7, UpdateNotificationPreferencesRequest{})
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})

	t.Run("lists and deletes connected accounts", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		var deleted db.DeleteOAuthAccountParams
		svc := NewUserService(&userCovQuerier{
			listAccountsFn: func(_ context.Context, userID int64) ([]db.OauthAccount, error) {
				require.Equal(t, int64(5), userID)
				return []db.OauthAccount{{
					ID:             11,
					UserID:         userID,
					Provider:       "github",
					ProviderUserID: "gh-123",
					CreatedAt:      now,
					UpdatedAt:      now.Add(time.Minute),
				}}, nil
			},
			deleteAcctFn: func(_ context.Context, arg db.DeleteOAuthAccountParams) error {
				deleted = arg
				return nil
			},
		})

		accounts, err := svc.ListConnectedAccounts(ctx, 5)
		require.NoError(t, err)
		require.Len(t, accounts, 1)
		assert.Equal(t, int64(11), accounts[0].ID)
		assert.Equal(t, "github", accounts[0].Provider)
		assert.Equal(t, "gh-123", accounts[0].ProviderID)
		assert.Equal(t, now, accounts[0].CreatedAt)

		require.NoError(t, svc.DeleteConnectedAccount(ctx, 5, 11))
		assert.Equal(t, db.DeleteOAuthAccountParams{ID: 11, UserID: 5}, deleted)
	})

	t.Run("maps connected account failures", func(t *testing.T) {
		svc := NewUserService(&userCovQuerier{
			listAccountsFn: func(context.Context, int64) ([]db.OauthAccount, error) {
				return nil, errors.New("query failed")
			},
			deleteAcctFn: func(context.Context, db.DeleteOAuthAccountParams) error {
				return errors.New("delete failed")
			},
		})

		_, err := svc.ListConnectedAccounts(ctx, 5)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))

		err = svc.DeleteConnectedAccount(ctx, 5, 0)
		assert.Equal(t, 400, mustAPIErrorStatus(t, err))

		err = svc.DeleteConnectedAccount(ctx, 5, 11)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}

func TestUser_Cov_InactiveActivityAndOwnerResolutionBranches(t *testing.T) {
	ctx := context.Background()

	t.Run("inactive authenticated user is hidden", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				user := testDBUser()
				user.IsActive = false
				return user, nil
			},
		})
		_, err := svc.GetAuthenticatedUser(ctx, 42)
		assert.Equal(t, 404, mustAPIErrorStatus(t, err))
	})

	t.Run("formats activity fallbacks", func(t *testing.T) {
		tests := []struct {
			name string
			log  db.AuditLog
			want string
		}{
			{name: "known event without target", log: db.AuditLog{EventType: "repo.delete"}, want: "deleted repository"},
			{name: "custom action and target", log: db.AuditLog{EventType: "custom.event", Action: "renamed", TargetName: "demo"}, want: "renamed demo"},
			{name: "target only", log: db.AuditLog{EventType: "custom.event", TargetName: "demo"}, want: "demo"},
			{name: "event fallback", log: db.AuditLog{EventType: "repo.star"}, want: "repo star"},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				assert.Equal(t, tc.want, formatActivitySummary(tc.log))
			})
		}
	})

	t.Run("caches user and org owners while mapping repository summaries", func(t *testing.T) {
		var userLookups, orgLookups int
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
				userLookups++
				require.Equal(t, int64(7), id)
				return db.User{ID: id, Username: "alice"}, nil
			},
			getOrgByIDFn: func(_ context.Context, id int64) (db.Organization, error) {
				orgLookups++
				require.Equal(t, int64(9), id)
				return db.Organization{ID: id, Name: "acme"}, nil
			},
		})
		repos := []db.Repository{
			{ID: 1, Name: "one", UserID: pgtype.Int8{Int64: 7, Valid: true}},
			{ID: 2, Name: "two", UserID: pgtype.Int8{Int64: 7, Valid: true}},
			{ID: 3, Name: "ops", OrgID: pgtype.Int8{Int64: 9, Valid: true}},
			{ID: 4, Name: "infra", OrgID: pgtype.Int8{Int64: 9, Valid: true}},
		}

		items, err := svc.mapRepoSummariesWithResolvedOwners(ctx, repos)
		require.NoError(t, err)
		require.Len(t, items, 4)
		assert.Equal(t, "alice/one", items[0].FullName)
		assert.Equal(t, "alice/two", items[1].FullName)
		assert.Equal(t, "acme/ops", items[2].FullName)
		assert.Equal(t, "acme/infra", items[3].FullName)
		assert.Equal(t, 1, userLookups)
		assert.Equal(t, 1, orgLookups)
	})

	t.Run("owner resolution errors are mapped", func(t *testing.T) {
		svc := NewUserService(&mockUserQuerier{
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
			getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
				return db.Organization{}, errors.New("db failed")
			},
		})
		cache := &repoOwnerCache{users: map[int64]string{}, orgs: map[int64]string{}}

		_, err := svc.resolveRepoOwnerName(ctx, db.Repository{UserID: pgtype.Int8{Int64: 7, Valid: true}}, cache)
		assert.Equal(t, 404, mustAPIErrorStatus(t, err))

		_, err = svc.resolveRepoOwnerName(ctx, db.Repository{OrgID: pgtype.Int8{Int64: 9, Valid: true}}, cache)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))

		_, err = svc.resolveRepoOwnerName(ctx, db.Repository{}, cache)
		assert.Equal(t, 500, mustAPIErrorStatus(t, err))
	})
}
