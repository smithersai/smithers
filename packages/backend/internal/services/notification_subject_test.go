package services

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// notifications.subject is VARCHAR(255). A watcher notification embedding a
// 255-char issue/landing title produces a ~271-char subject; without truncation
// the INSERT fails (SQLSTATE 22001) and NotifyWatchers silently drops it for every
// watcher. Create must defensively truncate the subject to fit the column.
func TestNotificationService_Create_TruncatesOverlongSubject(t *testing.T) {
	var captured db.CreateNotificationParams
	mock := &mockNotificationQuerier{
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			captured = arg
			return db.Notification{ID: 1, Subject: arg.Subject}, nil
		},
	}
	svc := NewNotificationService(mock)

	longSubject := "New issue: " + strings.Repeat("x", 255) + " (#1)" // 271 chars
	_, err := svc.Create(context.Background(), db.CreateNotificationParams{Subject: longSubject})
	require.NoError(t, err)

	if runes := len([]rune(captured.Subject)); runes > maxNotificationSubjectLen {
		t.Fatalf("subject not truncated: %d runes (want <=%d)", runes, maxNotificationSubjectLen)
	}
}
