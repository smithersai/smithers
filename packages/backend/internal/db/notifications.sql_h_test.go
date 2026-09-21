package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type notificationsSQLHDB = chunk5SQLHDB
type notificationsSQLHRow = chunk5SQLHRow
type notificationsSQLHRows = chunk5SQLHRows

func TestNotificationsSQL_H_GetAndListCursors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	first, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: userID, SourceType: "issue", SourceID: pgtype.Int8{Int64: 1, Valid: true}, Subject: "one", Body: "first"})
	require.NoError(t, err)
	second, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: userID, SourceType: "issue", SourceID: pgtype.Int8{Int64: 2, Valid: true}, Subject: "two", Body: "second"})
	require.NoError(t, err)

	got, err := q.GetNotificationByID(ctx, first.ID)
	require.NoError(t, err)
	assert.Equal(t, "one", got.Subject)
	byUser, err := q.ListNotificationsByUser(ctx, ListNotificationsByUserParams{UserID: userID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, byUser, 2)
	after, err := q.ListNotificationsAfterID(ctx, ListNotificationsAfterIDParams{UserID: userID, AfterID: first.ID, MaxResults: 10})
	require.NoError(t, err)
	require.Len(t, after, 1)
	assert.Equal(t, second.ID, after[0].ID)
	keyset, err := q.ListNotificationsByUserKeyset(ctx, ListNotificationsByUserKeysetParams{UserID: userID, BeforeID: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, keyset, 2)
	keyset, err = q.ListNotificationsByUserKeyset(ctx, ListNotificationsByUserKeysetParams{UserID: userID, BeforeID: second.ID, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, keyset, 1)
	assert.Equal(t, first.ID, keyset[0].ID)
	_, err = q.GetNotificationByID(ctx, 999999999)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	empty, err := q.ListNotificationsAfterID(ctx, ListNotificationsAfterIDParams{UserID: userID, AfterID: second.ID, MaxResults: 10})
	require.NoError(t, err)
	assert.Empty(t, empty)
}

func TestNotificationsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("notifications h failed")
	listCases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListNotificationsAfterID", func(q *Queries) error {
			_, err := q.ListNotificationsAfterID(context.Background(), ListNotificationsAfterIDParams{UserID: 1, MaxResults: 1})
			return err
		}},
		{"ListNotificationsByUser", func(q *Queries) error {
			_, err := q.ListNotificationsByUser(context.Background(), ListNotificationsByUserParams{UserID: 1, PageSize: 1})
			return err
		}},
		{"ListNotificationsByUserKeyset", func(q *Queries) error {
			_, err := q.ListNotificationsByUserKeyset(context.Background(), ListNotificationsByUserKeysetParams{UserID: 1, PageSize: 1})
			return err
		}},
	}
	for _, tc := range listCases {
		require.ErrorIs(t, tc.call(New(notificationsSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(notificationsSQLHDB{rows: &notificationsSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(notificationsSQLHDB{rows: &notificationsSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}
	_, err := New(notificationsSQLHDB{row: notificationsSQLHRow{err: sentinel}}).GetNotificationByID(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}
