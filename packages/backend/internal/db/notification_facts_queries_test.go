package db

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestNotificationFactsCaptureLifecycleRollbackAndPrivacy(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	user := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	first, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: user, SourceType: "issue", Subject: "first"})
	require.NoError(t, err)
	second, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: user, SourceType: "issue", Subject: "second"})
	require.NoError(t, err)
	require.NoError(t, q.MarkNotificationRead(ctx, MarkNotificationReadParams{UserID: user, ID: first.ID}))
	require.NoError(t, q.MarkAllNotificationsRead(ctx, user))
	require.NoError(t, q.MarkAllNotificationsRead(ctx, user)) // no changed rows => no extra fact
	_, err = sharedPool.Exec(ctx, `UPDATE notifications SET status='unread',read_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, second.ID)
	require.NoError(t, err)
	_, err = sharedPool.Exec(ctx, `UPDATE notifications SET body='updated',status='pinned',updated_at=clock_timestamp() WHERE id=$1`, second.ID)
	require.NoError(t, err)
	_, err = sharedPool.Exec(ctx, `DELETE FROM notifications WHERE id=$1`, first.ID)
	require.NoError(t, err)
	journal, err := q.GetNotificationJournal(ctx, user)
	require.NoError(t, err)
	require.Equal(t, int64(7), journal.Head)
	rows, err := q.ListNotificationFacts(ctx, ListNotificationFactsParams{UserID: user, ThroughSequence: journal.Head, PageSize: 1000})
	require.NoError(t, err)
	require.Len(t, rows, 7)
	expected := []string{"notification.created", "notification.created", "notification.read", "notification.read", "notification.unread", "notification.updated", "notification.deleted"}
	seen := map[string]bool{}
	for index, row := range rows {
		require.Equal(t, int64(index+1), row.Sequence)
		require.Equal(t, expected[index], row.EventType)
		require.False(t, seen[row.EventID])
		seen[row.EventID] = true
		require.False(t, row.RecordedAt.IsZero())
	}
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	_, err = New(tx).CreateNotification(ctx, CreateNotificationParams{UserID: user, SourceType: "issue", Subject: "rolled back"})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	journal, err = q.GetNotificationJournal(ctx, user)
	require.NoError(t, err)
	require.Equal(t, int64(7), journal.Head)
	_, err = sharedPool.Exec(ctx, `UPDATE notification_facts SET event_type='notification.updated' WHERE user_id=$1`, user)
	require.ErrorContains(t, err, "append-only")
	_, err = sharedPool.Exec(ctx, `DELETE FROM notification_facts WHERE user_id=$1`, user)
	require.ErrorContains(t, err, "append-only")
	_, err = sharedPool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user)
	require.NoError(t, err, "privacy cascade must not be blocked by journal guards")
	for _, table := range []string{"notifications", "notification_facts", "notification_journals"} {
		var count int
		require.NoError(t, sharedPool.QueryRow(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE user_id=$1", table), user).Scan(&count))
		require.Zero(t, count, table)
	}
}

func TestNotificationFactsCommittedPositionsAndWakeup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q := New(sharedPool)
	user := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	n1, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: user, SourceType: "issue"})
	require.NoError(t, err)
	n2, err := q.CreateNotification(ctx, CreateNotificationParams{UserID: user, SourceType: "issue"})
	require.NoError(t, err)
	listener, err := pgx.Connect(ctx, resolveDBTestDatabaseURL(os.Getenv))
	require.NoError(t, err)
	defer listener.Close(ctx)
	_, err = listener.Exec(ctx, fmt.Sprintf("LISTEN notification_facts_%d", user))
	require.NoError(t, err)
	tx1, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx1.Rollback(context.Background())
	require.NoError(t, New(tx1).MarkNotificationRead(ctx, MarkNotificationReadParams{UserID: user, ID: n1.ID}))
	tx2, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx2.Rollback(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- New(tx2).MarkNotificationRead(ctx, MarkNotificationReadParams{UserID: user, ID: n2.ID})
	}()
	awaitStreamWriterBlocked(t, ctx, tx2.Conn().PgConn().PID())
	journal, err := q.GetNotificationJournal(ctx, user)
	require.NoError(t, err)
	require.Equal(t, int64(2), journal.Head, "uncommitted head must not be visible")
	waitCtx, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	_, err = listener.WaitForNotification(waitCtx)
	stop()
	require.Error(t, err, "wake must not be delivered before commit")
	require.NoError(t, tx1.Commit(ctx))
	require.NoError(t, <-done)
	notification, err := listener.WaitForNotification(ctx)
	require.NoError(t, err)
	require.Equal(t, "3", notification.Payload)
	require.NoError(t, tx2.Commit(ctx))
	journal, err = q.GetNotificationJournal(ctx, user)
	require.NoError(t, err)
	require.Equal(t, int64(4), journal.Head)
	rows, err := q.ListNotificationFacts(ctx, ListNotificationFactsParams{UserID: user, AfterSequence: 2, ThroughSequence: 4, PageSize: 1000})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, n1.ID, rows[0].NotificationID)
	require.Equal(t, n2.ID, rows[1].NotificationID)
}
