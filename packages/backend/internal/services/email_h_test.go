package services

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
)

type emailHTransport struct {
	err  error
	sent chan email.Message
}

func (t *emailHTransport) Send(_ context.Context, msg email.Message) error {
	if t.sent != nil {
		t.sent <- msg
	}
	return t.err
}

func TestEmail_H_DefaultSpawnAndNotificationBranches(t *testing.T) {
	transport := &emailHTransport{sent: make(chan email.Message, 8)}
	svc := NewEmailService(mockEmailQuerier{}, transport, testEmailServiceConfig())

	svc.SendBillingNotification(context.Background(), " billing@example.com ", " Billing ", "line 1\nline 2")
	select {
	case msg := <-transport.sent:
		assert.Equal(t, []string{"billing@example.com"}, msg.To)
		assert.Equal(t, "Billing", msg.Subject)
		assert.Contains(t, msg.HTML, "line 1<br>line 2")
	case <-time.After(time.Second):
		t.Fatal("billing email was not sent")
	}

	svc.SendBillingNotification(context.Background(), " ", "subject", "body")
	select {
	case msg := <-transport.sent:
		t.Fatalf("blank billing notification should not send: %#v", msg)
	default:
	}

	failing := &emailHTransport{err: errors.New("smtp down"), sent: make(chan email.Message, 8)}
	svc = NewEmailService(mockEmailQuerier{}, failing, testEmailServiceConfig())
	svc.spawn = syncSpawn

	svc.SendMentionNotification(context.Background(), "mention@example.com", "alice", "", "snippet", "")
	assert.Empty(t, failing.sent)
	svc.SendMentionNotification(context.Background(), "mention@example.com", "alice", "Issue #1", "snippet", "")
	require.Len(t, failing.sent, 1)

	svc.SendSecurityAlert(context.Background(), "security@example.com", email.SecurityAlertTemplateData{})
	require.Len(t, failing.sent, 1)
	svc.SendSecurityAlert(context.Background(), "security@example.com", email.SecurityAlertTemplateData{Detail: "new key"})
	require.Len(t, failing.sent, 2)

	svc.SendDigestNotification(context.Background(), "digest@example.com", email.DigestTemplateData{})
	require.Len(t, failing.sent, 2)
	svc.SendDigestNotification(context.Background(), "digest@example.com", email.DigestTemplateData{
		Items:          []email.DigestItem{{Subject: "Build", Body: "failed", Time: "now"}},
		TotalCount:     0,
		UnsubscribeURL: "https://example.test/unsub",
	})
	require.Len(t, failing.sent, 3)
	var sent []email.Message
	for len(failing.sent) > 0 {
		sent = append(sent, <-failing.sent)
	}
	require.Len(t, sent, 3)
	assert.Equal(t, "You have 0 notifications — Smithers", sent[2].Subject)
}

func TestEmail_H_RequestVerificationErrorBranches(t *testing.T) {
	svc := newTestEmailService(mockEmailQuerier{})
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, svc.RequestVerification(context.Background(), 0, 1)))
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, svc.RequestVerification(context.Background(), 1, 0)))

	svc = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, errors.New("db down")
		},
	})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.RequestVerification(context.Background(), 1, 2)))

	oldRandRead := emailRandRead
	emailRandRead = func([]byte) (int, error) { return 0, errors.New("entropy unavailable") }
	t.Cleanup(func() { emailRandRead = oldRandRead })
	svc = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 2, UserID: 1, Email: "a@example.com"}, nil
		},
	})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.RequestVerification(context.Background(), 1, 2)))
	emailRandRead = oldRandRead

	svc = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 2, UserID: 1, Email: "a@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(context.Context, db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{}, errors.New("insert failed")
		},
	})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.RequestVerification(context.Background(), 1, 2)))
}

func TestEmail_H_VerifyEmailBranches(t *testing.T) {
	_, err := newTestEmailService(mockEmailQuerier{}).VerifyEmail(context.Background(), "")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	token := db.EmailVerificationToken{UserID: 7, Email: "User@Example.com", ExpiresAt: time.Now().Add(time.Hour)}
	tests := []struct {
		name string
		q    mockEmailQuerier
		want int
	}{
		{
			name: "missing token",
			q: mockEmailQuerier{getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
				return db.EmailVerificationToken{}, pgx.ErrNoRows
			}},
			want: http.StatusBadRequest,
		},
		{
			name: "load token error",
			q: mockEmailQuerier{getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
				return db.EmailVerificationToken{}, errors.New("read failed")
			}},
			want: http.StatusInternalServerError,
		},
		{
			name: "expired token",
			q: mockEmailQuerier{getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
				expired := token
				expired.ExpiresAt = time.Now().Add(-time.Minute)
				return expired, nil
			}},
			want: http.StatusBadRequest,
		},
		{
			name: "used token",
			q: mockEmailQuerier{getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
				used := token
				used.UsedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
				return used, nil
			}},
			want: http.StatusBadRequest,
		},
		{
			name: "consume error",
			q: mockEmailQuerier{
				getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
				consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 0, errors.New("consume failed") },
			},
			want: http.StatusInternalServerError,
		},
		{
			name: "consume race",
			q: mockEmailQuerier{
				getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
				consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 0, nil },
			},
			want: http.StatusBadRequest,
		},
		{
			name: "list emails error",
			q: mockEmailQuerier{
				getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
				consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 1, nil },
				listUserEmailsFn:                  func(context.Context, int64) ([]db.EmailAddress, error) { return nil, errors.New("list failed") },
			},
			want: http.StatusInternalServerError,
		},
		{
			name: "email missing",
			q: mockEmailQuerier{
				getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
				consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 1, nil },
				listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
					return []db.EmailAddress{{ID: 1, Email: "other@example.com"}}, nil
				},
			},
			want: http.StatusNotFound,
		},
		{
			name: "activate error",
			q: mockEmailQuerier{
				getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
				consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 1, nil },
				listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
					return []db.EmailAddress{{ID: 9, Email: "user@example.com"}}, nil
				},
				activateEmailFn: func(context.Context, db.ActivateEmailParams) error { return errors.New("activate failed") },
			},
			want: http.StatusInternalServerError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := newTestEmailService(tt.q).VerifyEmail(context.Background(), "raw-token")
			require.Error(t, err)
			assert.Equal(t, tt.want, apiStatus(t, err))
		})
	}

	var activated db.ActivateEmailParams
	svc := newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) { return token, nil },
		consumeEmailVerificationTokenFn:   func(context.Context, string) (int64, error) { return 1, nil },
		listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{{ID: 9, Email: "user@example.com"}}, nil
		},
		activateEmailFn: func(_ context.Context, arg db.ActivateEmailParams) error {
			activated = arg
			return nil
		},
	})
	result, err := svc.VerifyEmail(context.Background(), "raw-token")
	require.NoError(t, err)
	assert.Equal(t, VerifyEmailResult{UserID: 7, Email: "User@Example.com"}, result)
	assert.Equal(t, db.ActivateEmailParams{ID: 9, UserID: 7}, activated)
}

func TestEmail_H_ValidationAndUniqueHelpers(t *testing.T) {
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, validateEmail(strings.Repeat("x", 255)+"@example.com")))
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, validateEmail("Alice <alice@example.com>")))
	assert.False(t, isEmailUniqueViolation(nil))
	assert.True(t, isEmailUniqueViolation(errors.New("duplicate key violates unique index")))
	assert.False(t, isEmailUniqueViolation(io.ErrUnexpectedEOF))
}
