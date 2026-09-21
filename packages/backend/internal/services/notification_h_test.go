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

func notificationHRow(userID int64) db.Notification {
	return db.Notification{
		ID:         9,
		UserID:     userID,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 4, Valid: true},
		Subject:    "subject",
		Body:       "body",
		Status:     "unread",
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}
}

func TestNotification_H_ServiceTxAndCreateErrorBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewNotificationServiceWithPool(&mockNotificationQuerier{}, nil)
	assert.Nil(t, svc.createTxManager)

	svc = NewNotificationService(&mockNotificationQuerier{})
	svc.createTxManager = &mockNotificationCreateTxManager{
		beginFn: func(context.Context) (notificationCreateTx, error) {
			return nil, errors.New("begin failed")
		},
	}
	_, err := svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	rolledBack := false
	svc.createTxManager = &mockNotificationCreateTxManager{
		beginFn: func(context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
					return notificationHRow(1), nil
				},
				notifyFn: func(context.Context, db.NotifyUserParams) error { return errors.New("notify failed") },
				rollbackFn: func(context.Context) error {
					rolledBack = true
					return nil
				},
			}, nil
		},
	}
	_, err = svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, rolledBack)

	badTime := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	rolledBack = false
	svc.createTxManager = &mockNotificationCreateTxManager{
		beginFn: func(context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
					row := notificationHRow(1)
					row.CreatedAt = badTime
					return row, nil
				},
				rollbackFn: func(context.Context) error {
					rolledBack = true
					return nil
				},
			}, nil
		},
	}
	_, err = svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, rolledBack)

	rolledBack = false
	svc.createTxManager = &mockNotificationCreateTxManager{
		beginFn: func(context.Context) (notificationCreateTx, error) {
			return &mockNotificationCreateTx{
				createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
					return notificationHRow(1), nil
				},
				commitFn: func(context.Context) error { return errors.New("commit failed") },
				rollbackFn: func(context.Context) error {
					rolledBack = true
					return nil
				},
			}, nil
		},
	}
	_, err = svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, rolledBack)

	svc = NewNotificationService(&mockNotificationQuerier{
		createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
			row := notificationHRow(1)
			row.CreatedAt = badTime
			return row, nil
		},
	})
	_, err = svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewNotificationService(&mockNotificationQuerier{
		createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
			return notificationHRow(1), nil
		},
		notifyFn: func(context.Context, db.NotifyUserParams) error { return errors.New("notify failed") },
	})
	_, err = svc.Create(ctx, db.CreateNotificationParams{UserID: 1, SourceType: "issue", Subject: "s"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestNotification_H_ReadWatchersAndPayloadBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewNotificationService(&mockNotificationQuerier{
		getByIDFn: func(context.Context, int64) (db.Notification, error) {
			return db.Notification{}, pgx.ErrNoRows
		},
	})
	err := svc.MarkRead(ctx, 1, 9)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = NewNotificationService(&mockNotificationQuerier{
		getByIDFn: func(context.Context, int64) (db.Notification, error) {
			return db.Notification{}, errors.New("read failed")
		},
	})
	err = svc.MarkRead(ctx, 1, 9)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	createAttempts := 0
	svc = NewNotificationService(&mockNotificationQuerier{
		listWatchersFn: func(context.Context, int64) ([]db.ListActiveWatchersForRepoRow, error) {
			return []db.ListActiveWatchersForRepoRow{{ID: 7}}, nil
		},
		getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{NotifyIssues: true, NotifyLandings: false, NotifyMentions: true}, nil
		},
		createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
			createAttempts++
			return db.Notification{}, errors.New("create failed")
		},
	})
	svc.notifyWatchersSync(ctx, 3, "issue", 4, "subject", "body")
	assert.Equal(t, 1, createAttempts)
	assert.False(t, svc.watcherWantsSource(ctx, 7, "landing"))
	assert.True(t, svc.watcherWantsSource(ctx, 7, "unknown"))

	svc = NewNotificationService(&mockNotificationQuerier{
		getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{}, errors.New("prefs failed")
		},
	})
	// A real preference read failure fails closed so it cannot bypass opt-outs.
	assert.False(t, svc.watcherWantsSource(ctx, 7, "issue"))

	readAt := time.Now().UTC()
	resp := toNotificationResponse(db.Notification{
		ID:        1,
		UserID:    2,
		ReadAt:    pgtype.Timestamptz{Time: readAt, Valid: true},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	})
	require.NotNil(t, resp.ReadAt)
	assert.Equal(t, readAt, *resp.ReadAt)

	_, err = buildNotificationPayload(db.Notification{CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)})
	require.Error(t, err)
}
