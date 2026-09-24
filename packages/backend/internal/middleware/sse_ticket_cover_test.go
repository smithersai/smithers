package middleware

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sseauth"
)

func TestSseTicket_Cov_ValidatorChainFailureFallbacks(t *testing.T) {
	t.Parallel()

	principal, err := NewSSETicketValidatorChain(nil).ValidateTicket(context.Background(), "ticket")
	require.Nil(t, principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid SSE ticket")

	lastErr := apierrors.Forbidden("last validator denied")
	chain := NewSSETicketValidatorChain(
		&mockSSETicketValidator{validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, apierrors.Unauthorized("first validator denied")
		}},
		&mockSSETicketValidator{validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, lastErr
		}},
	)

	principal, err = chain.ValidateTicket(context.Background(), "ticket")
	require.Nil(t, principal)
	assert.Same(t, lastErr, err)
}

func TestSseTicket_Cov_ManagerValidatorEdges(t *testing.T) {
	t.Parallel()

	var nilValidator *SSETicketManagerValidator
	principal, err := nilValidator.ValidateTicket(context.Background(), "ticket")
	require.Nil(t, principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid SSE ticket")

	manager := sseauth.NewSSETicketManager("cover-secret")
	ticket, _, err := manager.Issue(sseauth.SSETicketSubject{UserID: 55})
	require.NoError(t, err)
	validator := NewSSETicketManagerValidator(manager, nil)

	principal, err = validator.ValidateTicket(context.Background(), ticket)
	require.NoError(t, err)
	require.NotNil(t, principal)
	assert.Equal(t, int64(55), principal.User.ID)

	ticket, _, err = manager.Issue(sseauth.SSETicketSubject{UserID: 56})
	require.NoError(t, err)
	validator = NewSSETicketManagerValidator(manager, &mockSSETicketUserLoader{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	})
	principal, err = validator.ValidateTicket(context.Background(), ticket)
	require.Nil(t, principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid or expired SSE ticket")

	ticket, _, err = manager.Issue(sseauth.SSETicketSubject{UserID: 57})
	require.NoError(t, err)
	validator = NewSSETicketManagerValidator(manager, &mockSSETicketUserLoader{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, assert.AnError
		},
	})
	principal, err = validator.ValidateTicket(context.Background(), ticket)
	require.Nil(t, principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to load SSE ticket user")
}
