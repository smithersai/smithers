package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type usersSQLHDB = chunk5SQLHDB
type usersSQLHRow = chunk5SQLHRow
type usersSQLHRows = chunk5SQLHRows

func TestUsersSQL_H_NotificationsListSearchAndSuspend(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	username := uniqueTestUsername(t)
	userID := mustCreateUser(t, pool, username)

	prefs, err := q.GetUserNotificationPreferences(ctx, userID)
	require.NoError(t, err)
	assert.True(t, prefs.EmailNotificationsEnabled)
	updated, err := q.UpdateUserNotificationPreferences(ctx, UpdateUserNotificationPreferencesParams{UserID: userID, EmailNotificationsEnabled: false})
	require.NoError(t, err)
	assert.False(t, updated.EmailNotificationsEnabled)
	prefs, err = q.GetUserNotificationPreferences(ctx, userID)
	require.NoError(t, err)
	assert.False(t, prefs.EmailNotificationsEnabled)

	users, err := q.ListUsers(ctx, ListUsersParams{PageOffset: 0, PageSize: 100})
	require.NoError(t, err)
	assert.True(t, usersSQLHHasUser(users, userID))
	found, err := q.SearchUsers(ctx, SearchUsersParams{SearchQuery: strings.ToLower(username) + "%", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, found, 1)
	assert.Equal(t, userID, found[0].ID)

	require.NoError(t, q.SuspendUser(ctx, userID))
	afterSuspend, err := q.SearchUsers(ctx, SearchUsersParams{SearchQuery: strings.ToLower(username) + "%", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, afterSuspend)
	_, err = q.GetUserNotificationPreferences(ctx, 999999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateUserNotificationPreferences(ctx, UpdateUserNotificationPreferencesParams{UserID: 999999999, EmailNotificationsEnabled: true})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestUsersSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("users h failed")
	for _, call := range []func(*Queries) error{
		func(q *Queries) error {
			_, err := q.ListUsers(context.Background(), ListUsersParams{PageSize: 1})
			return err
		},
		func(q *Queries) error {
			_, err := q.SearchUsers(context.Background(), SearchUsersParams{SearchQuery: "a%", PageSize: 1})
			return err
		},
	} {
		require.ErrorIs(t, call(New(usersSQLHDB{queryErr: sentinel})), sentinel)
		require.ErrorIs(t, call(New(usersSQLHDB{rows: &usersSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		require.ErrorIs(t, call(New(usersSQLHDB{rows: &usersSQLHRows{err: sentinel}})), sentinel)
	}
	rowQ := New(usersSQLHDB{row: usersSQLHRow{err: sentinel}})
	_, err := rowQ.GetUserNotificationPreferences(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.UpdateUserNotificationPreferences(context.Background(), UpdateUserNotificationPreferencesParams{})
	require.ErrorIs(t, err, sentinel)
	require.ErrorIs(t, New(usersSQLHDB{execErr: sentinel}).SuspendUser(context.Background(), 1), sentinel)
}

func usersSQLHHasUser(users []User, id int64) bool {
	for _, user := range users {
		if user.ID == id {
			return true
		}
	}
	return false
}
