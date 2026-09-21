package db

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListAndMarkNotifications(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "notify-user")

	mustExec(t, pool, `INSERT INTO notifications (user_id, source_type, source_id, subject, body, status) VALUES ($1, 'issue', 1, 's1', 'b1', 'unread')`, userID)
	mustExec(t, pool, `INSERT INTO notifications (user_id, source_type, source_id, subject, body, status) VALUES ($1, 'issue', 2, 's2', 'b2', 'unread')`, userID)

	list, err := q.ListNotificationsByUser(context.Background(), ListNotificationsByUserParams{
		UserID:     userID,
		PageSize:   1,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, list, 1)

	totalCount, err := q.CountNotificationsByUser(context.Background(), userID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), totalCount)

	err = q.MarkNotificationRead(context.Background(), MarkNotificationReadParams{ID: list[0].ID, UserID: userID})
	require.NoError(t, err)

	var status string
	err = pool.QueryRow(context.Background(), `SELECT status FROM notifications WHERE id = $1`, list[0].ID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "read", status)

	err = q.MarkAllNotificationsRead(context.Background(), userID)
	require.NoError(t, err)

	var unread int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND status = 'unread'`, userID).Scan(&unread)
	require.NoError(t, err)
	assert.Equal(t, int64(0), unread)
}

func TestCreateNotification(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "notify-create-user")

	created, err := q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID:     userID,
		SourceType: "issue",
		SourceID:   pgtype.Int8{Int64: 123, Valid: true},
		Subject:    "you were mentioned",
		Body:       "in issue #123",
	})
	require.NoError(t, err)
	assert.Equal(t, userID, created.UserID)
	assert.Equal(t, "issue", created.SourceType)
	assert.True(t, created.SourceID.Valid)
	assert.Equal(t, int64(123), created.SourceID.Int64)
	assert.Equal(t, "you were mentioned", created.Subject)
	assert.Equal(t, "in issue #123", created.Body)
	assert.Equal(t, "unread", created.Status)

	var count int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM notifications WHERE id = $1 AND user_id = $2`, created.ID, userID).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestListNotificationsAfterID(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "notify-afterid-user")
	otherUserID := mustCreateUser(t, pool, "notify-afterid-other")

	// Insert 4 notifications for the target user.
	n1, err := q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID: userID, SourceType: "issue", Subject: "s1", Body: "b1",
	})
	require.NoError(t, err)

	n2, err := q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID: userID, SourceType: "issue", Subject: "s2", Body: "b2",
	})
	require.NoError(t, err)

	n3, err := q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID: userID, SourceType: "landing", Subject: "s3", Body: "b3",
	})
	require.NoError(t, err)

	n4, err := q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID: userID, SourceType: "mention", Subject: "s4", Body: "b4",
	})
	require.NoError(t, err)

	// Insert a notification for a different user (should never appear).
	_, err = q.CreateNotification(context.Background(), CreateNotificationParams{
		UserID: otherUserID, SourceType: "issue", Subject: "other", Body: "other",
	})
	require.NoError(t, err)

	t.Run("returns notifications after the given ID in ascending order", func(t *testing.T) {
		// Request notifications after n2 → should get n3, n4.
		list, err := q.ListNotificationsAfterID(context.Background(), ListNotificationsAfterIDParams{
			UserID:     userID,
			AfterID:    n2.ID,
			MaxResults: 100,
		})
		require.NoError(t, err)
		require.Len(t, list, 2)
		assert.Equal(t, n3.ID, list[0].ID)
		assert.Equal(t, n4.ID, list[1].ID)
	})

	t.Run("returns empty when afterID is the latest notification", func(t *testing.T) {
		list, err := q.ListNotificationsAfterID(context.Background(), ListNotificationsAfterIDParams{
			UserID:     userID,
			AfterID:    n4.ID,
			MaxResults: 100,
		})
		require.NoError(t, err)
		assert.Empty(t, list)
	})

	t.Run("respects max_results limit", func(t *testing.T) {
		// Request after n1 with limit=1 → should get only n2.
		list, err := q.ListNotificationsAfterID(context.Background(), ListNotificationsAfterIDParams{
			UserID:     userID,
			AfterID:    n1.ID,
			MaxResults: 1,
		})
		require.NoError(t, err)
		require.Len(t, list, 1)
		assert.Equal(t, n2.ID, list[0].ID)
	})

	t.Run("does not return notifications for other users", func(t *testing.T) {
		// Request with afterID=0 for the target user → should get n1..n4 only.
		list, err := q.ListNotificationsAfterID(context.Background(), ListNotificationsAfterIDParams{
			UserID:     userID,
			AfterID:    0,
			MaxResults: 100,
		})
		require.NoError(t, err)
		require.Len(t, list, 4)
		for _, n := range list {
			assert.Equal(t, userID, n.UserID)
		}
	})

	_ = n1 // suppress unused warnings
	_ = n3
}

func TestNotifyUser(t *testing.T) {
	// NOTIFY only delivers after COMMIT, so this test uses sharedPool directly
	// instead of the per-test transaction.
	seq := testSeqCounter.Add(1)
	username := fmt.Sprintf("notify-listener-user-%d", seq)
	userID := mustCreateUser(t, sharedPool, username)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = $1`, userID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	channel := fmt.Sprintf("user_notifications_%d", userID)
	payload := `{"id":999,"subject":"hello"}`

	listenerConn, err := sharedPool.Acquire(context.Background())
	require.NoError(t, err)
	defer listenerConn.Release()

	// #nosec G202 -- test channel is deterministic and derived from numeric ID.
	_, err = listenerConn.Exec(context.Background(), "LISTEN "+channel)
	require.NoError(t, err)

	poolQ := New(sharedPool)
	err = poolQ.NotifyUser(context.Background(), NotifyUserParams{
		UserID:  userID,
		Payload: payload,
	})
	require.NoError(t, err)

	waitCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	notification, err := listenerConn.Conn().WaitForNotification(waitCtx)
	require.NoError(t, err)
	assert.Equal(t, channel, notification.Channel)
	assert.Equal(t, payload, notification.Payload)
}
