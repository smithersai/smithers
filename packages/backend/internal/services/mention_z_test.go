package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mentionZEmailSender struct {
	calls int
}

func (s *mentionZEmailSender) SendMentionNotification(context.Context, string, string, string, string, string) {
	s.calls++
}

func TestMention_Z_NotificationAndEmailErrorBranches(t *testing.T) {
	user := db.User{ID: 5, Username: "Alice", LowerUsername: "alice"}
	notifier := NewNotificationService(&mockNotificationQuerier{
		getPrefsFn: func(context.Context, int64) (db.UserNotificationPreference, error) {
			return db.UserNotificationPreference{NotifyMentions: true}, nil
		},
		createFn: func(context.Context, db.CreateNotificationParams) (db.Notification, error) {
			return db.Notification{}, errors.New("notify failed")
		},
	})
	svc := NewMentionService(&mockMentionQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return user, nil
		},
		createMentionFn: func(context.Context, db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
	}, notifier)
	err := svc.ProcessMentions(context.Background(), "@alice", MentionContext{
		RepositoryID: 1,
		IssueID:      pgtype.Int8{Int64: 9, Valid: true},
	}, "subject")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "notify failed")

	sender := &mentionZEmailSender{}
	user.EmailNotificationsEnabled = true
	svc = NewMentionService(&mockMentionQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return user, nil
		},
		createMentionFn: func(context.Context, db.CreateMentionParams) (db.Mention, error) {
			return db.Mention{}, nil
		},
		getPrimaryEmailFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, errors.New("email lookup failed")
		},
	}, nil, WithMentionEmailSender(sender))
	require.NoError(t, svc.ProcessMentions(context.Background(), "@alice", MentionContext{RepositoryID: 1}, "subject"))
	assert.Zero(t, sender.calls)
}
