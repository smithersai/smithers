package services

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
)

func TestLinearIntegration_Z_ConfigAndSetupErrorBranches(t *testing.T) {
	ctx := context.Background()
	_, err := NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, nil, "secret").CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Equal(t, 400, apiStatus(t, err))

	baseQueries := &mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) { return 1, nil },
	}
	_, err = NewLinearIntegrationService(baseQueries, linearIntegrationHClient{
		exchangeFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{}, errors.New("exchange failed")
		},
	}, "secret").CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Equal(t, 500, apiStatus(t, err))

	oldMarshal := linearIntegrationJSONMarshal
	t.Cleanup(func() { linearIntegrationJSONMarshal = oldMarshal })
	linearIntegrationJSONMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal failed") }
	_, err = NewLinearIntegrationService(nil, nil, "secret").CreateOAuthSetup(ctx, 1, LinearOAuthCallbackResult{})
	require.Equal(t, 500, apiStatus(t, err))
	linearIntegrationJSONMarshal = oldMarshal

	oldEncrypt := linearIntegrationEncrypt
	t.Cleanup(func() { linearIntegrationEncrypt = oldEncrypt })
	linearIntegrationEncrypt = func([]byte, []byte) ([]byte, error) { return nil, errors.New("encrypt failed") }
	_, err = NewLinearIntegrationService(nil, nil, "secret").CreateOAuthSetup(ctx, 1, LinearOAuthCallbackResult{})
	require.Equal(t, 500, apiStatus(t, err))

	_, err = NewLinearIntegrationService(nil, nil, "secret").ConfigureIntegration(ctx, 1, ConfigureLinearIntegrationRequest{AccessToken: "access"})
	require.Equal(t, 500, apiStatus(t, err))

	linearIntegrationEncrypt = func(key, plaintext []byte) ([]byte, error) {
		if bytes.Equal(plaintext, []byte("refresh")) {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	_, err = NewLinearIntegrationService(nil, nil, "secret").ConfigureIntegration(ctx, 1, ConfigureLinearIntegrationRequest{AccessToken: "access", RefreshToken: "refresh"})
	require.Equal(t, 500, apiStatus(t, err))

	calls := 0
	linearIntegrationEncrypt = func(key, plaintext []byte) ([]byte, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("webhook encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	_, err = NewLinearIntegrationService(nil, nil, "secret").ConfigureIntegration(ctx, 1, ConfigureLinearIntegrationRequest{AccessToken: "access"})
	require.Equal(t, 500, apiStatus(t, err))
	linearIntegrationEncrypt = oldEncrypt
}

func TestLinearIntegration_Z_RefreshEncryptionErrorBranches(t *testing.T) {
	ctx := context.Background()
	secret := "linear-secret"
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	expired := db.LinearIntegration{
		ID:                    42,
		AccessTokenEncrypted:  linearIntegrationHEncrypt(t, secret, "old-access"),
		RefreshTokenEncrypted: linearIntegrationHEncrypt(t, secret, "old-refresh"),
		TokenExpiresAt:        pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
	}

	oldEncrypt := linearIntegrationEncrypt
	t.Cleanup(func() { linearIntegrationEncrypt = oldEncrypt })
	linearIntegrationEncrypt = func(key, plaintext []byte) ([]byte, error) {
		if bytes.Equal(plaintext, []byte("new-access")) {
			return nil, errors.New("access encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, linearIntegrationHClient{
		refreshFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
		},
	}, secret)
	svc.now = func() time.Time { return now }
	_, err := svc.RefreshTokenIfNeeded(ctx, expired)
	require.Equal(t, 500, apiStatus(t, err))

	linearIntegrationEncrypt = func(key, plaintext []byte) ([]byte, error) {
		if bytes.Equal(plaintext, []byte("new-refresh")) {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, linearIntegrationHClient{
		refreshFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
		},
	}, secret)
	svc.now = func() time.Time { return now }
	_, err = svc.RefreshTokenIfNeeded(ctx, expired)
	require.Equal(t, 500, apiStatus(t, err))

	linearIntegrationEncrypt = smitherscrypto.Encrypt
}
