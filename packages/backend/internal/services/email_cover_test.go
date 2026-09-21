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
	"github.com/smithersai/smithers/packages/backend/internal/email"
)

func TestEmail_Cov_AddDeleteAndVerificationRequestErrors(t *testing.T) {
	ctx := context.Background()
	svc := NewEmailService(mockEmailQuerier{}, &email.NoopTransport{}, testEmailServiceConfig())
	require.NotNil(t, svc.spawn)
	assert.Equal(t, "http://localhost:4000", svc.cfg.BaseURL)

	_, err := svc.AddEmail(ctx, 0, AddEmailRequest{Email: "a@example.com"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = svc.AddEmail(ctx, 1, AddEmailRequest{Email: "Alice <alice@example.com>"})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	_, err = newTestEmailService(mockEmailQuerier{
		upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, errors.New("unique constraint violation")
		},
	}).AddEmail(ctx, 1, AddEmailRequest{Email: "dup@example.com"})
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	_, err = newTestEmailService(mockEmailQuerier{
		upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, errors.New("db down")
		},
	}).AddEmail(ctx, 1, AddEmailRequest{Email: "ok@example.com"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = svc.DeleteEmail(ctx, 0, 1)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	err = svc.DeleteEmail(ctx, 1, 0)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	err = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, errors.New("load failed")
		},
	}).DeleteEmail(ctx, 1, 2)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	err = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 2, UserID: 1, Email: "a@example.com"}, nil
		},
		deleteEmailFn: func(context.Context, db.DeleteEmailParams) error { return errors.New("delete failed") },
	}).DeleteEmail(ctx, 1, 2)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = svc.RequestVerification(ctx, 0, 1)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	err = svc.RequestVerification(ctx, 1, 0)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	err = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, errors.New("load failed")
		},
	}).RequestVerification(ctx, 1, 2)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	err = newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 2, UserID: 1, Email: "verify@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(context.Context, db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{}, errors.New("insert failed")
		},
	}).RequestVerification(ctx, 1, 2)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	assert.False(t, isEmailUniqueViolation(nil))
	assert.False(t, isEmailUniqueViolation(errors.New("plain failure")))
}

func TestEmail_Cov_BestEffortNotifications(t *testing.T) {
	transport := &email.NoopTransport{}
	svc := newTestEmailServiceWithTransport(mockEmailQuerier{}, transport)

	svc.SendMentionNotification(context.Background(), "mention@example.com", "alice", "Issue #1", "hello", "https://example.test/issues/1")
	svc.SendSecurityAlert(context.Background(), "security@example.com", email.SecurityAlertTemplateData{
		Username:  "alice",
		AlertType: "new_login",
		Detail:    "New sign-in",
		IPAddress: "203.0.113.10",
		Timestamp: "2026-07-07 12:00 UTC",
		ActionURL: "https://example.test/settings/security",
	})
	svc.SendBillingNotification(context.Background(), " billing@example.com ", " Payment failed ", "Line one\nLine two")
	svc.SendBillingNotification(context.Background(), "", "missing", "body")
	svc.SendDigestNotification(context.Background(), "digest@example.com", email.DigestTemplateData{
		Username:   "alice",
		TotalCount: 1,
		Items: []email.DigestItem{{
			Subject: "Build passed",
			Body:    "All checks passed",
			URL:     "https://example.test/run/1",
			Time:    "now",
		}},
		SettingsURL:    "https://example.test/settings/notifications",
		UnsubscribeURL: "https://example.test/unsubscribe",
	})
	svc.SendSecurityAlert(context.Background(), "bad-security@example.com", email.SecurityAlertTemplateData{Username: "alice"})
	svc.SendDigestNotification(context.Background(), "bad-digest@example.com", email.DigestTemplateData{Username: "alice"})

	require.Len(t, transport.Sent, 4)
	assert.Contains(t, transport.Sent[0].Subject, "You were mentioned")
	assert.Equal(t, []string{"security@example.com"}, transport.Sent[1].To)
	assert.Equal(t, "Payment failed", transport.Sent[2].Subject)
	assert.Contains(t, transport.Sent[2].HTML, "Line one<br>Line two")
	assert.Equal(t, "https://example.test/unsubscribe", transport.Sent[3].UnsubscribeURL)
}

func TestEmail_Cov_VerifyEmailSuccessAndFailures(t *testing.T) {
	ctx := context.Background()
	rawToken := "raw-verification-token"
	tokenHash := sha256Hex(rawToken)
	now := time.Now().UTC()
	var activated db.ActivateEmailParams
	svc := newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(_ context.Context, hash string) (db.EmailVerificationToken, error) {
			assert.Equal(t, tokenHash, hash)
			return db.EmailVerificationToken{ID: 1, UserID: 42, Email: "verify@example.com", TokenHash: hash, ExpiresAt: now.Add(time.Hour)}, nil
		},
		consumeEmailVerificationTokenFn: func(_ context.Context, hash string) (int64, error) {
			assert.Equal(t, tokenHash, hash)
			return 1, nil
		},
		listUserEmailsFn: func(_ context.Context, userID int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{{ID: 7, UserID: userID, Email: "Verify@Example.com"}}, nil
		},
		activateEmailFn: func(_ context.Context, arg db.ActivateEmailParams) error {
			activated = arg
			return nil
		},
	})
	result, err := svc.VerifyEmail(ctx, rawToken)
	require.NoError(t, err)
	assert.Equal(t, int64(42), result.UserID)
	assert.Equal(t, "verify@example.com", result.Email)
	assert.Equal(t, db.ActivateEmailParams{ID: 7, UserID: 42}, activated)

	_, err = svc.VerifyEmail(ctx, "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{}, pgx.ErrNoRows
		},
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{}, errors.New("load failed")
		},
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	for _, token := range []db.EmailVerificationToken{
		{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(-time.Minute)},
		{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(time.Hour), UsedAt: pgtype.Timestamptz{Time: now, Valid: true}},
	} {
		_, err = newTestEmailService(mockEmailQuerier{
			getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
				return token, nil
			},
		}).VerifyEmail(ctx, rawToken)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	}

	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(time.Hour)}, nil
		},
		consumeEmailVerificationTokenFn: func(context.Context, string) (int64, error) {
			return 0, nil
		},
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(time.Hour)}, nil
		},
		consumeEmailVerificationTokenFn: func(context.Context, string) (int64, error) { return 1, nil },
		listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
			return nil, errors.New("list failed")
		},
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(time.Hour)}, nil
		},
		consumeEmailVerificationTokenFn: func(context.Context, string) (int64, error) { return 1, nil },
		listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{{ID: 7, UserID: 42, Email: "other@example.com"}}, nil
		},
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	_, err = newTestEmailService(mockEmailQuerier{
		getEmailVerificationTokenByHashFn: func(context.Context, string) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{UserID: 42, Email: "verify@example.com", ExpiresAt: now.Add(time.Hour)}, nil
		},
		consumeEmailVerificationTokenFn: func(context.Context, string) (int64, error) { return 1, nil },
		listUserEmailsFn: func(context.Context, int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{{ID: 7, UserID: 42, Email: "verify@example.com"}}, nil
		},
		activateEmailFn: func(context.Context, db.ActivateEmailParams) error { return errors.New("activate failed") },
	}).VerifyEmail(ctx, rawToken)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}
