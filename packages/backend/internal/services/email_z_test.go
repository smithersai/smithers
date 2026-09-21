package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
)

func TestEmail_Z_VerificationRenderAndBillingSendErrors(t *testing.T) {
	oldRender := renderVerificationEmail
	renderVerificationEmail = func(email.VerificationTemplateData) (string, string, error) {
		return "", "", errors.New("render failed")
	}
	t.Cleanup(func() { renderVerificationEmail = oldRender })

	svc := newTestEmailService(mockEmailQuerier{
		getEmailByIDFn: func(context.Context, int64) (db.EmailAddress, error) {
			return db.EmailAddress{ID: 2, UserID: 1, Email: "a@example.com"}, nil
		},
		createEmailVerificationTokenFn: func(context.Context, db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error) {
			return db.EmailVerificationToken{}, nil
		},
	})
	require.NoError(t, svc.RequestVerification(context.Background(), 1, 2))

	failing := &emailHTransport{err: errors.New("smtp down"), sent: make(chan email.Message, 1)}
	svc = NewEmailService(mockEmailQuerier{}, failing, testEmailServiceConfig())
	svc.spawn = syncSpawn
	svc.SendBillingNotification(context.Background(), "billing@example.com", "subject", "body")
	assert.Len(t, failing.sent, 1)
}
