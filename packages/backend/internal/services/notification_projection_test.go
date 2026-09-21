package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func notificationProjectionFact(sequence int64, kind, status string) NotificationFact {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	value := NotificationResponse{ID: 7, SourceType: "issue", SourceID: int64(9), Subject: "hello", Body: "body", Status: status, CreatedAt: now, UpdatedAt: now}
	if status == "read" {
		value.ReadAt = &now
	}
	fact := NotificationFact{ID: uuid.NewString(), StreamID: "notifications:1", Sequence: sequence, SchemaVersion: 1, Type: kind, NotificationID: 7, RecordedAt: now, Notification: &value}
	if kind == "notification.deleted" {
		fact.Notification = nil
	}
	return fact
}

func TestNotificationProjectionPureUpdatesAndValidation(t *testing.T) {
	created := notificationProjectionFact(1, "notification.created", "unread")
	empty := NotificationProjection{}
	first, err := ApplyNotificationFact(empty, created)
	require.NoError(t, err)
	require.Nil(t, empty.Notifications)
	read := notificationProjectionFact(2, "notification.read", "read")
	second, err := ApplyNotificationFact(first, read)
	require.NoError(t, err)
	require.Equal(t, "unread", first.Notifications[7].Status)
	require.Equal(t, "read", second.Notifications[7].Status)
	duplicate, err := ApplyNotificationFact(second, read)
	require.NoError(t, err)
	require.Equal(t, second, duplicate)
	bad := read
	bad.SchemaVersion = 2
	unchanged, err := ApplyNotificationFact(second, bad)
	require.Error(t, err)
	require.Equal(t, second, unchanged)
	bad = read
	bad.StreamID = "notifications:2"
	_, err = ApplyNotificationFact(second, bad)
	require.ErrorContains(t, err, "identity mismatch")
	bad = notificationProjectionFact(3, "notification.updated", "read")
	bad.Notification.UpdatedAt = time.Time{}
	_, err = ApplyNotificationFact(second, bad)
	require.ErrorContains(t, err, "timestamps missing")
	bad = notificationProjectionFact(3, "notification.deleted", "")
	bad.Notification = read.Notification
	_, err = ApplyNotificationFact(second, bad)
	require.ErrorContains(t, err, "must omit post-image")
	deleted, err := ApplyNotificationFact(second, notificationProjectionFact(3, "notification.deleted", ""))
	require.NoError(t, err)
	require.Empty(t, deleted.Notifications)
	require.Len(t, second.Notifications, 1)
	_, err = RebuildNotificationProjection([]NotificationFact{created, notificationProjectionFact(3, "notification.read", "read")})
	require.ErrorContains(t, err, "gap")
	rebuilt, err := RebuildNotificationProjection([]NotificationFact{created, read, notificationProjectionFact(3, "notification.deleted", "")})
	require.NoError(t, err)
	require.Empty(t, rebuilt.Notifications)
}

func TestNotificationProjectionMatchesCommittedRows(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var user int64
	name := fmt.Sprintf("notification_projection_%d", time.Now().UnixNano())
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, name).Scan(&user))
	service := NewNotificationServiceWithPool(q, pool)
	ids := make([]int64, 0, 80)
	for index := 0; index < 80; index++ {
		row, err := service.Create(ctx, db.CreateNotificationParams{UserID: user, SourceType: "issue", SourceID: pgtype.Int8{Int64: int64(index + 1), Valid: true}, Subject: fmt.Sprintf("notice %d", index), Body: fmt.Sprintf("body %d", index)})
		require.NoError(t, err)
		ids = append(ids, row.ID)
		if index%3 == 0 {
			require.NoError(t, service.MarkRead(ctx, user, row.ID))
		}
	}
	require.NoError(t, service.MarkAllRead(ctx, user))
	for index, id := range ids {
		if index%4 == 0 {
			_, err := pool.Exec(ctx, `UPDATE notifications SET status='unread',read_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, id)
			require.NoError(t, err)
		}
		if index%11 == 0 {
			_, err := pool.Exec(ctx, `UPDATE notifications SET subject='renamed',body='accepted content edit',status='pinned',updated_at=clock_timestamp() WHERE id=$1`, id)
			require.NoError(t, err)
		}
		if index%7 == 0 {
			_, err := pool.Exec(ctx, `DELETE FROM notifications WHERE id=$1`, id)
			require.NoError(t, err)
		}
	}
	// Both the journal and materialized rows are compared from one MVCC snapshot.
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	snapshot := db.New(tx)
	journal, err := snapshot.GetNotificationJournal(ctx, user)
	require.NoError(t, err)
	var facts []NotificationFact
	var cursor int64
	for cursor < journal.Head {
		rows, err := snapshot.ListNotificationFacts(ctx, db.ListNotificationFactsParams{UserID: user, AfterSequence: cursor, ThroughSequence: journal.Head, PageSize: 17})
		require.NoError(t, err)
		require.NotEmpty(t, rows)
		for _, row := range rows {
			fact, _, err := DecodeNotificationFact(row)
			require.NoError(t, err)
			facts = append(facts, fact)
			cursor = fact.Sequence
		}
	}
	projection, err := RebuildNotificationProjection(facts)
	require.NoError(t, err)
	require.Equal(t, journal.Head, projection.Cursor)
	current, err := snapshot.ListNotificationsAfterID(ctx, db.ListNotificationsAfterIDParams{UserID: user, MaxResults: 1000})
	require.NoError(t, err)
	expected := map[int64]NotificationResponse{}
	for _, row := range current {
		row.CreatedAt = row.CreatedAt.UTC()
		row.UpdatedAt = row.UpdatedAt.UTC()
		if row.ReadAt.Valid {
			row.ReadAt.Time = row.ReadAt.Time.UTC()
		}
		expected[row.ID] = toNotificationResponse(row)
	}
	require.Equal(t, expected, projection.Notifications, "fold(accepted facts) must equal persisted notification state at the same snapshot")
}

type notificationFactTestQueries struct {
	*mockNotificationQuerier
	head int64
	rows []db.ListNotificationFactsRow
}

func (q *notificationFactTestQueries) GetNotificationJournal(context.Context, int64) (db.NotificationJournal, error) {
	return db.NotificationJournal{Head: q.head, CoverageKind: "legacy_snapshot", CoverageStartedAt: time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)}, nil
}
func (q *notificationFactTestQueries) ListNotificationFacts(_ context.Context, arg db.ListNotificationFactsParams) ([]db.ListNotificationFactsRow, error) {
	rows := []db.ListNotificationFactsRow{}
	for _, row := range q.rows {
		if row.Sequence > arg.AfterSequence && row.Sequence <= arg.ThroughSequence && len(rows) < int(arg.PageSize) {
			rows = append(rows, row)
		}
	}
	return rows, nil
}
func notificationFactTestRow(seq, id, sourceID, currentSourceID int64) db.ListNotificationFactsRow {
	historical, _ := json.Marshal(map[string]any{"id": id, "source_type": "issue", "source_id": sourceID, "subject": "private snippet", "body": "private body", "status": "unread", "created_at": "2026-09-14T00:00:00Z", "updated_at": "2026-09-14T00:00:00Z"})
	current, _ := json.Marshal(map[string]any{"id": id, "source_type": "issue", "source_id": currentSourceID})
	return db.ListNotificationFactsRow{UserID: 5, Sequence: seq, EventID: uuid.NewString(), SchemaVersion: 1, EventType: "notification.created", NotificationID: id, PostImage: historical, CurrentPostImage: current, RecordedAt: time.Now().UTC()}
}
func TestNotificationFactServingGatesHistoricalAndCurrentSources(t *testing.T) {
	q := &notificationFactTestQueries{mockNotificationQuerier: &mockNotificationQuerier{
		getIssueByIDFn: func(_ context.Context, id int64) (db.Issue, error) { return db.Issue{ID: id, RepositoryID: id}, nil },
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, IsPublic: id == 1, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}, head: 3, rows: []db.ListNotificationFactsRow{notificationFactTestRow(1, 10, 1, 2), notificationFactTestRow(2, 11, 2, 1), notificationFactTestRow(3, 12, 1, 1)}}
	page, err := NewNotificationService(q).ListNotificationFacts(context.Background(), 5, 0, 1000)
	require.NoError(t, err)
	require.True(t, page.VisibilityFiltered)
	require.Equal(t, int64(3), page.Cursor)
	require.Len(t, page.Events, 1)
	require.Equal(t, int64(12), page.Events[0].NotificationID)
	require.Equal(t, "legacy_snapshot", page.Coverage.Kind)
	data, err := json.Marshal(page)
	require.NoError(t, err)
	require.NotContains(t, string(data), `"notification_id":10`)
	require.NotContains(t, string(data), `"notification_id":11`)
	_, err = NewNotificationService(q).ListNotificationFacts(context.Background(), 5, 99, 1000)
	require.Error(t, err)
}

func TestNotificationFactServingFailsClosedOnMissingFactsAndPermissionErrors(t *testing.T) {
	for _, test := range []struct {
		name            string
		rows            []db.ListNotificationFactsRow
		permissionError bool
		message         string
	}{
		{name: "missing middle fact", rows: []db.ListNotificationFactsRow{notificationFactTestRow(2, 10, 1, 1)}, message: "journal gap"},
		{name: "truncated retained journal", message: "journal truncated"},
		{name: "permission unavailable", rows: []db.ListNotificationFactsRow{notificationFactTestRow(1, 10, 1, 1)}, permissionError: true, message: "resolve notification issue"},
	} {
		t.Run(test.name, func(t *testing.T) {
			q := &notificationFactTestQueries{mockNotificationQuerier: &mockNotificationQuerier{
				getIssueByIDFn: func(context.Context, int64) (db.Issue, error) {
					if test.permissionError {
						return db.Issue{}, fmt.Errorf("permission store unavailable")
					}
					return db.Issue{RepositoryID: 1}, nil
				},
			}, head: 2, rows: test.rows}
			page, err := NewNotificationService(q).ListNotificationFacts(context.Background(), 5, 0, 1000)
			require.ErrorContains(t, err, test.message)
			require.Zero(t, page.Cursor)
			require.Empty(t, page.Events)
		})
	}
}
