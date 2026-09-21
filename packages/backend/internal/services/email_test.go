package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// testEmailServiceConfig returns a config suitable for unit tests.
func testEmailServiceConfig() EmailServiceConfig {
	return EmailServiceConfig{
		BaseURL: "http://localhost:4000",
		From:    "noreply@smithers.sh",
	}
}

// syncSpawn is a spawn function that runs f synchronously for tests.
func syncSpawn(f func()) { f() }

// newTestEmailService creates an EmailService with a noop transport and synchronous spawn for testing.
func newTestEmailService(q EmailQuerier) *EmailService {
	svc := NewEmailService(q, &email.NoopTransport{}, testEmailServiceConfig())
	svc.spawn = syncSpawn
	return svc
}

// newTestEmailServiceWithTransport creates an EmailService with the given transport and synchronous spawn.
func newTestEmailServiceWithTransport(q EmailQuerier, t email.Transport) *EmailService {
	svc := NewEmailService(q, t, testEmailServiceConfig())
	svc.spawn = syncSpawn
	return svc
}

type mockEmailQuerier struct {
	listUserEmailsFn                  func(ctx context.Context, userID int64) ([]db.EmailAddress, error)
	getEmailByIDFn                    func(ctx context.Context, id int64) (db.EmailAddress, error)
	upsertEmailAddressFn              func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error)
	deleteEmailFn                     func(ctx context.Context, arg db.DeleteEmailParams) error
	getPrimaryEmailFn                 func(ctx context.Context, userID int64) (db.EmailAddress, error)
	createEmailVerificationTokenFn    func(ctx context.Context, arg db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error)
	getEmailVerificationTokenByHashFn func(ctx context.Context, tokenHash string) (db.EmailVerificationToken, error)
	consumeEmailVerificationTokenFn   func(ctx context.Context, tokenHash string) (int64, error)
	activateEmailFn                   func(ctx context.Context, arg db.ActivateEmailParams) error
}

func (m mockEmailQuerier) ListUserEmails(ctx context.Context, userID int64) ([]db.EmailAddress, error) {
	if m.listUserEmailsFn != nil {
		return m.listUserEmailsFn(ctx, userID)
	}
	return nil, nil
}

func (m mockEmailQuerier) GetEmailByID(ctx context.Context, id int64) (db.EmailAddress, error) {
	if m.getEmailByIDFn != nil {
		return m.getEmailByIDFn(ctx, id)
	}
	return db.EmailAddress{}, nil
}

func (m mockEmailQuerier) UpsertEmailAddress(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
	if m.upsertEmailAddressFn != nil {
		return m.upsertEmailAddressFn(ctx, arg)
	}
	return db.UpsertEmailAddressRow{}, nil
}

func (m mockEmailQuerier) DeleteEmail(ctx context.Context, arg db.DeleteEmailParams) error {
	if m.deleteEmailFn != nil {
		return m.deleteEmailFn(ctx, arg)
	}
	return nil
}

func (m mockEmailQuerier) GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error) {
	if m.getPrimaryEmailFn != nil {
		return m.getPrimaryEmailFn(ctx, userID)
	}
	return db.EmailAddress{}, nil
}

func (m mockEmailQuerier) CreateEmailVerificationToken(ctx context.Context, arg db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
	if m.createEmailVerificationTokenFn != nil {
		return m.createEmailVerificationTokenFn(ctx, arg)
	}
	return db.EmailVerificationToken{}, nil
}

func (m mockEmailQuerier) GetEmailVerificationTokenByHash(ctx context.Context, tokenHash string) (db.EmailVerificationToken, error) {
	if m.getEmailVerificationTokenByHashFn != nil {
		return m.getEmailVerificationTokenByHashFn(ctx, tokenHash)
	}
	return db.EmailVerificationToken{}, nil
}

func (m mockEmailQuerier) ConsumeEmailVerificationToken(ctx context.Context, tokenHash string) (int64, error) {
	if m.consumeEmailVerificationTokenFn != nil {
		return m.consumeEmailVerificationTokenFn(ctx, tokenHash)
	}
	return 0, nil
}

func (m mockEmailQuerier) ActivateEmail(ctx context.Context, arg db.ActivateEmailParams) error {
	if m.activateEmailFn != nil {
		return m.activateEmailFn(ctx, arg)
	}
	return nil
}

func TestEmailService_ListEmails(t *testing.T) {
	t.Parallel()
	now := time.Now()
	svc := newTestEmailService(mockEmailQuerier{
		listUserEmailsFn: func(_ context.Context, userID int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{
				{ID: 1, UserID: userID, Email: "a@example.com", IsPrimary: true, IsActivated: true, CreatedAt: now},
				{ID: 2, UserID: userID, Email: "b@example.com", IsPrimary: false, IsActivated: false, CreatedAt: now},
			}, nil
		},
	})
	emails, err := svc.ListEmails(context.Background(), 42)
	require.NoError(t, err)
	require.Len(t, emails, 2)
	assert.Equal(t, "a@example.com", emails[0].Email)
	assert.True(t, emails[0].IsPrimary)
	assert.Equal(t, "b@example.com", emails[1].Email)
	assert.False(t, emails[1].IsPrimary)
}

func TestEmailService_ListEmails_Empty(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		listUserEmailsFn: func(_ context.Context, _ int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{}, nil
		},
	})
	emails, err := svc.ListEmails(context.Background(), 42)
	require.NoError(t, err)
	require.Len(t, emails, 0)
}

func TestEmailService_ListEmails_InvalidUser(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{})
	_, err := svc.ListEmails(context.Background(), 0)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
}

func TestEmailService_ListEmails_DBError(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		listUserEmailsFn: func(_ context.Context, _ int64) ([]db.EmailAddress, error) {
			return nil, errors.New("db connection failed")
		},
	})
	_, err := svc.ListEmails(context.Background(), 42)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
}

func TestEmailService_ListEmails_DBOwnershipEnforced(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		listUserEmailsFn: func(_ context.Context, _ int64) ([]db.EmailAddress, error) {
			return []db.EmailAddress{
				{ID: 1, UserID: 42, Email: "mine@example.com"},
				{ID: 2, UserID: 99, Email: "theirs@example.com"},
			}, nil
		},
	})
	emails, err := svc.ListEmails(context.Background(), 42)
	require.NoError(t, err)
	require.Len(t, emails, 1)
	assert.Equal(t, "mine@example.com", emails[0].Email)
}

func TestEmailService_AddEmail(t *testing.T) {
	t.Parallel()
	now := time.Now()
	svc := newTestEmailService(mockEmailQuerier{
		upsertEmailAddressFn: func(_ context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{
				ID: 10, UserID: arg.UserID, Email: arg.Email, LowerEmail: arg.LowerEmail,
				IsActivated: false, IsPrimary: arg.IsPrimary, CreatedAt: now, UpdatedAt: now,
			}, nil
		},
	})
	resp, err := svc.AddEmail(context.Background(), 42, AddEmailRequest{Email: "test@example.com", IsPrimary: false})
	require.NoError(t, err)
	assert.Equal(t, int64(10), resp.ID)
	assert.Equal(t, "test@example.com", resp.Email)
	assert.False(t, resp.IsActivated)
	assert.False(t, resp.IsPrimary)
}

func TestEmailService_AddEmail_InvalidEmail(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{})
	tests := []struct {
		name  string
		email string
	}{
		{"empty", ""},
		{"no_at", "notanemail"},
		{"no_domain", "user@"},
		{"no_local", "@domain.com"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.AddEmail(context.Background(), 42, AddEmailRequest{Email: tc.email})
			require.Error(t, err)
			var apiErr *pkgerrors.APIError
			require.True(t, errors.As(err, &apiErr))
			assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
		})
	}
}

func TestEmailService_AddEmail_Duplicate(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		upsertEmailAddressFn: func(_ context.Context, _ db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, &pgconn.PgError{Code: "23505"}
		},
	})
	_, err := svc.AddEmail(context.Background(), 42, AddEmailRequest{Email: "dup@example.com"})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusConflict, apiErr.Status)
}

func TestEmailService_DeleteEmail(t *testing.T) {
	t.Parallel()
	deleteCalled := false
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 42, Email: "del@example.com"}, nil
		},
		deleteEmailFn: func(_ context.Context, arg db.DeleteEmailParams) error {
			deleteCalled = true
			assert.Equal(t, int64(10), arg.ID)
			assert.Equal(t, int64(42), arg.UserID)
			return nil
		},
	})
	err := svc.DeleteEmail(context.Background(), 42, 10)
	require.NoError(t, err)
	assert.True(t, deleteCalled)
}

func TestEmailService_DeleteEmail_NotFound(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, _ int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, pgx.ErrNoRows
		},
	})
	err := svc.DeleteEmail(context.Background(), 42, 999)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
}

func TestEmailService_DeleteEmail_ForeignOwner(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 99, Email: "other@example.com"}, nil
		},
	})
	err := svc.DeleteEmail(context.Background(), 42, 10)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
}

func TestEmailService_RequestVerification(t *testing.T) {
	t.Parallel()
	tokenCreated := false
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 42, Email: "verify@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(_ context.Context, arg db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			tokenCreated = true
			assert.Equal(t, int64(42), arg.UserID)
			assert.Equal(t, "verify@example.com", arg.Email)
			assert.Equal(t, "verify", arg.TokenType)
			assert.NotEmpty(t, arg.TokenHash)
			return db.EmailVerificationToken{ID: 1}, nil
		},
	})
	err := svc.RequestVerification(context.Background(), 42, 10)
	require.NoError(t, err)
	assert.True(t, tokenCreated)
}

func TestEmailService_RequestVerification_UnconfiguredDoesNotCreateToken(t *testing.T) {
	t.Parallel()

	databaseCalled := false
	svc := newTestEmailServiceWithTransport(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			databaseCalled = true
			return db.EmailAddress{}, nil
		},
	}, &email.DisabledTransport{})

	err := svc.RequestVerification(t.Context(), 42, 10)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
	assert.Contains(t, apiErr.Message, "not configured")
	assert.False(t, databaseCalled)
}

func TestEmailService_RequestVerification_NotFound(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, _ int64) (db.EmailAddress, error) {
			return db.EmailAddress{}, pgx.ErrNoRows
		},
	})
	err := svc.RequestVerification(context.Background(), 42, 999)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
}

func TestEmailService_RequestVerification_ForeignOwner(t *testing.T) {
	t.Parallel()
	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 99, Email: "other@example.com"}, nil
		},
	})
	err := svc.RequestVerification(context.Background(), 42, 10)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
}

func TestEmailService_RequestVerification_SendsVerificationEmail(t *testing.T) {
	t.Parallel()
	transport := &email.NoopTransport{}
	svc := newTestEmailServiceWithTransport(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 42, Email: "verify@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(_ context.Context, _ db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{ID: 1}, nil
		},
	}, transport)
	err := svc.RequestVerification(context.Background(), 42, 10)
	require.NoError(t, err)
	require.Len(t, transport.Sent, 1)
	assert.Equal(t, []string{"verify@example.com"}, transport.Sent[0].To)
	assert.Contains(t, transport.Sent[0].Subject, "Verify")
	assert.Contains(t, transport.Sent[0].HTML, "verify@example.com")
	assert.Contains(t, transport.Sent[0].HTML, "verify-token?token=")
}

func TestEmailService_RequestVerification_SendFailureIsLoggedNotReturned(t *testing.T) {
	t.Parallel()
	// A transport that always fails.
	failTransport := &failingTransport{}
	svc := newTestEmailServiceWithTransport(mockEmailQuerier{
		getEmailByIDFn: func(_ context.Context, id int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: id, UserID: 42, Email: "fail@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(_ context.Context, _ db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{ID: 1}, nil
		},
	}, failTransport)
	// Should NOT return an error even though transport.Send will fail.
	err := svc.RequestVerification(context.Background(), 42, 10)
	require.NoError(t, err)
}

// failingTransport is a transport that always fails to send.
type failingTransport struct{}

func (f *failingTransport) Send(_ context.Context, _ email.Message) error {
	return errors.New("SMTP connection refused")
}

func TestEmailService_SendMentionNotification_SendsEmail(t *testing.T) {
	t.Parallel()
	transport := &email.NoopTransport{}
	svc := newTestEmailServiceWithTransport(mockEmailQuerier{}, transport)
	svc.SendMentionNotification(context.Background(), "alice@example.com", "alice", "Issue #42", "Hey @alice check this", "https://smithers.sh/org/repo/issues/42")
	require.Len(t, transport.Sent, 1)
	assert.Equal(t, []string{"alice@example.com"}, transport.Sent[0].To)
	assert.Contains(t, transport.Sent[0].Subject, "mentioned")
	assert.Contains(t, transport.Sent[0].HTML, "@alice")
	assert.Contains(t, transport.Sent[0].HTML, "Issue #42")
}
