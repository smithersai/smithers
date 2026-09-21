package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestNotificationStreamPageKeepsCursorAcrossEntireHiddenPage(t *testing.T) {
	svc := NewNotificationService(&mockNotificationQuerier{
		listAfterIDFn: func(_ context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error) {
			var rows []db.Notification
			for id := arg.AfterID + 1; id <= 2001 && len(rows) < int(arg.MaxResults); id++ {
				rows = append(rows, db.Notification{ID: id, UserID: 5, SourceType: "issue", SourceID: pgtype.Int8{Int64: id, Valid: true}})
			}
			return rows, nil
		},
		getIssueByIDFn: func(_ context.Context, id int64) (db.Issue, error) {
			if id <= 2000 {
				return db.Issue{}, pgx.ErrNoRows
			}
			return db.Issue{ID: id, RepositoryID: 10}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) { return db.Repository{ID: 10, IsPublic: true}, nil },
	})
	first, err := svc.ListNotificationStreamPage(context.Background(), 5, 0, 1000)
	require.NoError(t, err)
	require.Empty(t, first.Items)
	require.Equal(t, int64(1000), first.Cursor)
	require.True(t, first.More)
	second, err := svc.ListNotificationStreamPage(context.Background(), 5, first.Cursor, 1000)
	require.NoError(t, err)
	require.Empty(t, second.Items)
	require.Equal(t, int64(2000), second.Cursor)
	require.True(t, second.More)
	third, err := svc.ListNotificationStreamPage(context.Background(), 5, second.Cursor, 1000)
	require.NoError(t, err)
	require.Len(t, third.Items, 1)
	require.Equal(t, int64(2001), third.Items[0].ID)
	require.False(t, third.More)
}
