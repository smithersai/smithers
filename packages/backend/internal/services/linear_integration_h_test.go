package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
)

type linearIntegrationHClient struct {
	authURLFn  func(string) string
	exchangeFn func(context.Context, string) (LinearTokenResult, error)
	refreshFn  func(context.Context, string) (LinearTokenResult, error)
	viewerFn   func(context.Context, string) (LinearViewer, error)
	teamsFn    func(context.Context, string) ([]LinearTeam, error)
}

func (c linearIntegrationHClient) AuthorizationURL(state string) string {
	if c.authURLFn != nil {
		return c.authURLFn(state)
	}
	return "https://linear.example/oauth?state=" + state
}
func (c linearIntegrationHClient) ExchangeCode(ctx context.Context, code string) (LinearTokenResult, error) {
	return c.exchangeFn(ctx, code)
}
func (c linearIntegrationHClient) RefreshToken(ctx context.Context, refreshToken string) (LinearTokenResult, error) {
	return c.refreshFn(ctx, refreshToken)
}
func (c linearIntegrationHClient) FetchViewer(ctx context.Context, accessToken string) (LinearViewer, error) {
	return c.viewerFn(ctx, accessToken)
}
func (c linearIntegrationHClient) FetchTeams(ctx context.Context, accessToken string) ([]LinearTeam, error) {
	return c.teamsFn(ctx, accessToken)
}

func linearIntegrationHEncrypt(t *testing.T, secret, value string) []byte {
	t.Helper()
	ciphertext, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(secret), []byte(value))
	require.NoError(t, err)
	return ciphertext
}

func linearIntegrationHSetupPayload(t *testing.T, secret string, result LinearOAuthCallbackResult) []byte {
	t.Helper()
	payload, err := json.Marshal(result)
	require.NoError(t, err)
	return linearIntegrationHEncrypt(t, secret, string(payload))
}

func TestLinearIntegration_H_ConstructorAndOAuthErrors(t *testing.T) {
	ctx := context.Background()
	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, nil, "secret")
	assert.NotNil(t, svc.now())
	setupKey, err := svc.generateSetupKey()
	require.NoError(t, err)
	assert.Len(t, setupKey, 32)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		createOAuthStateFn: func(context.Context, db.CreateOAuthStateParams) (db.OauthState, error) {
			return db.OauthState{}, errors.New("insert state failed")
		},
	}, linearIntegrationHClient{}, "secret")
	_, err = svc.StartLinearOAuth(ctx, "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) {
			return 0, errors.New("consume failed")
		},
	}, linearIntegrationHClient{}, "secret")
	_, err = svc.CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	baseQueries := &mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}
	svc = NewLinearIntegrationService(baseQueries, linearIntegrationHClient{
		exchangeFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "access"}, nil
		},
		viewerFn: func(context.Context, string) (LinearViewer, error) {
			return LinearViewer{}, errors.New("viewer failed")
		},
	}, "secret")
	_, err = svc.CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewLinearIntegrationService(baseQueries, linearIntegrationHClient{
		exchangeFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "access"}, nil
		},
		viewerFn: func(context.Context, string) (LinearViewer, error) {
			return LinearViewer{ID: "viewer"}, nil
		},
		teamsFn: func(context.Context, string) ([]LinearTeam, error) {
			return nil, errors.New("teams failed")
		},
	}, "secret")
	_, err = svc.CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestLinearIntegration_H_OAuthSetupBranches(t *testing.T) {
	ctx := context.Background()
	secret := "linear-secret"
	result := LinearOAuthCallbackResult{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresAt:    time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC),
		Viewer:       LinearViewer{ID: "viewer"},
		Teams:        []LinearTeam{{ID: "team"}},
	}

	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		deleteLinearOAuthSetupsByUserFn: func(context.Context, int64) error {
			return errors.New("delete failed")
		},
	}, nil, secret)
	_, err := svc.CreateOAuthSetup(ctx, 7, result)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		createLinearOAuthSetupFn: func(context.Context, db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{}, errors.New("insert failed")
		},
	}, nil, secret)
	_, err = svc.CreateOAuthSetup(ctx, 7, result)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	payload := linearIntegrationHSetupPayload(t, secret, result)
	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		getLinearOAuthSetupByUserFn: func(context.Context, db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{}, errors.New("select failed")
		},
		consumeLinearOAuthSetupByUserFn: func(context.Context, db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{PayloadEncrypted: payload}, nil
		},
	}, nil, secret)
	_, err = svc.GetOAuthSetup(ctx, 7, "key")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	consumed, err := svc.ConsumeOAuthSetup(ctx, 7, " key ")
	require.NoError(t, err)
	assert.Equal(t, "viewer", consumed.Viewer.ID)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		consumeLinearOAuthSetupByUserFn: func(context.Context, db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{}, errors.New("consume failed")
		},
	}, nil, secret)
	_, err = svc.ConsumeOAuthSetup(ctx, 7, "key")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewLinearIntegrationService(nil, nil, secret).decodeOAuthSetup(linearIntegrationHEncrypt(t, secret, "{not-json"))
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestLinearIntegration_H_TokenAndIntegrationBranches(t *testing.T) {
	ctx := context.Background()
	secret := "linear-secret"
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)

	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		createLinearIntegrationFn: func(context.Context, db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			return db.LinearIntegration{}, errors.New("insert failed")
		},
	}, nil, secret)
	_, err := svc.ConfigureIntegration(ctx, 7, ConfigureLinearIntegrationRequest{AccessToken: "access", LinearTeamID: "team"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewLinearIntegrationService(nil, nil, secret)
	_, err = svc.GetDecryptedAccessToken(ctx, db.LinearIntegration{AccessTokenEncrypted: []byte("not-ciphertext")})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = svc.GetDecryptedWebhookSecret(db.LinearIntegration{WebhookSecret: "%%%"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = svc.GetDecryptedWebhookSecret(db.LinearIntegration{WebhookSecret: base64.StdEncoding.EncodeToString([]byte("bad"))})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	webhookCipher := linearIntegrationHEncrypt(t, secret, "webhook-secret")
	webhook, err := svc.GetDecryptedWebhookSecret(db.LinearIntegration{WebhookSecret: base64.StdEncoding.EncodeToString(webhookCipher)})
	require.NoError(t, err)
	assert.Equal(t, "webhook-secret", webhook)

	expired := db.LinearIntegration{
		ID:                    42,
		AccessTokenEncrypted:  linearIntegrationHEncrypt(t, secret, "old-access"),
		RefreshTokenEncrypted: linearIntegrationHEncrypt(t, secret, "old-refresh"),
		TokenExpiresAt:        pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
	}
	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, linearIntegrationHClient{
		refreshFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{}, errors.New("refresh failed")
		},
	}, secret)
	svc.now = func() time.Time { return now }
	_, err = svc.RefreshTokenIfNeeded(ctx, expired)
	require.ErrorContains(t, err, "linear token refresh failed")

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		updateLinearIntegrationTokensFn: func(context.Context, db.UpdateLinearIntegrationTokensParams) error {
			return errors.New("update failed")
		},
	}, linearIntegrationHClient{
		refreshFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "new-access", ExpiresAt: now.Add(time.Hour)}, nil
		},
	}, secret)
	svc.now = func() time.Time { return now }
	_, err = svc.RefreshTokenIfNeeded(ctx, expired)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		updateLinearIntegrationTokensFn: func(context.Context, db.UpdateLinearIntegrationTokensParams) error {
			return nil
		},
	}, linearIntegrationHClient{
		refreshFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "new-access", ExpiresAt: now.Add(time.Hour)}, nil
		},
	}, secret)
	svc.now = func() time.Time { return now }
	refreshed, err := svc.RefreshTokenIfNeeded(ctx, expired)
	require.NoError(t, err)
	assert.Nil(t, refreshed.RefreshTokenEncrypted)
	assert.True(t, refreshed.TokenExpiresAt.Valid)
}

func TestLinearIntegration_H_NotFoundSetupBranches(t *testing.T) {
	ctx := context.Background()
	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		getLinearOAuthSetupByUserFn: func(context.Context, db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{}, pgx.ErrNoRows
		},
		consumeLinearOAuthSetupByUserFn: func(context.Context, db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{}, pgx.ErrNoRows
		},
	}, nil, "secret")
	_, err := svc.GetOAuthSetup(ctx, 1, "missing")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.ConsumeOAuthSetup(ctx, 1, "missing")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}
