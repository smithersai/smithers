package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func userZQuerier(overrides ...func(*mockUserQuerier)) *mockUserQuerier {
	q := &mockUserQuerier{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return testDBUser(), nil
		},
		getUserByLowerUsername: func(context.Context, string) (db.User, error) {
			return testDBUser(), nil
		},
		getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
			return db.Organization{ID: 7, Name: "acme"}, nil
		},
		updateUserFn: func(_ context.Context, arg db.UpdateUserParams) (db.User, error) {
			user := testDBUser()
			user.ID = arg.UserID
			user.DisplayName = arg.DisplayName
			user.Bio = arg.Bio
			user.AvatarUrl = arg.AvatarUrl
			return user, nil
		},
		listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
			return nil, nil
		},
		countUserReposFn: func(context.Context, pgtype.Int8) (int64, error) {
			return 0, nil
		},
		listPublicUserReposFn: func(context.Context, db.ListPublicUserReposParams) ([]db.Repository, error) {
			return nil, nil
		},
		countPublicUserReposFn: func(context.Context, pgtype.Int8) (int64, error) {
			return 0, nil
		},
		listUserOrgsFn: func(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
			return nil, nil
		},
		countUserOrgsFn: func(context.Context, int64) (int64, error) {
			return 0, nil
		},
		listUserStarredReposFn: func(context.Context, db.ListUserStarredReposParams) ([]db.Repository, error) {
			return nil, nil
		},
		countUserStarredReposFn: func(context.Context, int64) (int64, error) {
			return 0, nil
		},
		listPublicUserStarredReposFn: func(context.Context, db.ListPublicUserStarredReposParams) ([]db.Repository, error) {
			return nil, nil
		},
		countPublicUserStarredReposFn: func(context.Context, int64) (int64, error) {
			return 0, nil
		},
		listPublicAuditLogsByActorFn: func(context.Context, db.ListPublicAuditLogsByActorParams) ([]db.AuditLog, error) {
			return nil, nil
		},
		countPublicAuditLogsByActorFn: func(context.Context, db.CountPublicAuditLogsByActorParams) (int64, error) {
			return 0, nil
		},
	}
	for _, override := range overrides {
		override(q)
	}
	return q
}

func TestUser_Z_ProfileAndRepoListErrors(t *testing.T) {
	ctx := context.Background()

	_, err := NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getUserByLowerUsername = func(context.Context, string) (db.User, error) {
			return db.User{}, errors.New("lookup failed")
		}
	})).GetUserByUsername(ctx, "alice")
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))

	_, err = NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("load failed")
		}
	})).UpdateAuthenticatedUser(ctx, 42, UpdateUserRequest{})
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))

	for name, updateErr := range map[string]error{
		"missing":   pgx.ErrNoRows,
		"duplicate": &pgconn.PgError{Code: "23505"},
		"generic":   errors.New("update failed"),
	} {
		t.Run("update_"+name, func(t *testing.T) {
			_, err := NewUserService(userZQuerier(func(q *mockUserQuerier) {
				q.updateUserFn = func(context.Context, db.UpdateUserParams) (db.User, error) {
					return db.User{}, updateErr
				}
			})).UpdateAuthenticatedUser(ctx, 42, UpdateUserRequest{})
			require.Error(t, err)
		})
	}

	_, err = NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("load failed")
		}
	})).ListAuthenticatedUserRepos(ctx, 42, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))

	_, err = NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.listUserReposFn = func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
			return nil, errors.New("list failed")
		}
	})).ListAuthenticatedUserRepos(ctx, 42, 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))

	_, err = NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getUserByLowerUsername = func(context.Context, string) (db.User, error) {
			return db.User{}, errors.New("lookup failed")
		}
	})).ListUserReposByUsername(ctx, "alice", 1, 30)
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))
}

func TestUser_Z_PreferenceLoadAndOwnerResolutionErrors(t *testing.T) {
	ctx := context.Background()

	for name, prefErr := range map[string]error{
		"missing": pgx.ErrNoRows,
		"generic": errors.New("pref failed"),
	} {
		t.Run("update_prefs_"+name, func(t *testing.T) {
			_, err := NewUserService(&userCovQuerier{
				getPrefsFn: func(context.Context, int64) (db.GetUserNotificationPreferencesRow, error) {
					return db.GetUserNotificationPreferencesRow{}, prefErr
				},
			}).UpdateNotificationPreferences(ctx, 42, UpdateNotificationPreferencesRequest{})
			require.Error(t, err)
		})
	}

	_, err := NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("owner failed")
		}
	})).resolveRepoOwnerName(ctx, db.Repository{UserID: pgtype.Int8{Int64: 9, Valid: true}}, &repoOwnerCache{users: map[int64]string{}, orgs: map[int64]string{}})
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))

	_, err = NewUserService(userZQuerier(func(q *mockUserQuerier) {
		q.getOrgByIDFn = func(context.Context, int64) (db.Organization, error) {
			return db.Organization{}, pgx.ErrNoRows
		}
	})).resolveRepoOwnerName(ctx, db.Repository{OrgID: pgtype.Int8{Int64: 7, Valid: true}}, &repoOwnerCache{users: map[int64]string{}, orgs: map[int64]string{}})
	require.Error(t, err)
	assert.Equal(t, 404, mustAPIErrorStatus(t, err))

	_, err = NewUserService(userZQuerier()).mapRepoSummariesWithResolvedOwners(ctx, []db.Repository{{ID: 1, Name: "orphan"}})
	require.Error(t, err)
	assert.Equal(t, 500, mustAPIErrorStatus(t, err))
}
