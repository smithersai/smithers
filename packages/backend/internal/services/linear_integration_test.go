package services

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type failingLinearRandomReader struct{}

func (failingLinearRandomReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}

type mockLinearIntegrationQuerier struct {
	createLinearIntegrationFn       func(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error)
	getLinearIntegrationFn          func(ctx context.Context, id int64) (db.LinearIntegration, error)
	getLinearIntegrationByUserAndID func(ctx context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error)
	getLinearIntegrationByTeamIDFn  func(ctx context.Context, linearTeamID string) (db.LinearIntegration, error)
	listLinearIntegrationsByUserFn  func(ctx context.Context, userID int64) ([]db.LinearIntegration, error)
	listLinearIntegrationsByRepoFn  func(ctx context.Context, repoID int64) ([]db.LinearIntegration, error)
	listActiveLinearIntegrationsFn  func(ctx context.Context) ([]db.LinearIntegration, error)
	updateLinearIntegrationTokensFn func(ctx context.Context, arg db.UpdateLinearIntegrationTokensParams) error
	updateLinearIntegrationLastSync func(ctx context.Context, id int64) error
	updateLinearIntegrationActiveFn func(ctx context.Context, arg db.UpdateLinearIntegrationActiveParams) error
	deleteLinearIntegrationFn       func(ctx context.Context, arg db.DeleteLinearIntegrationParams) error
	createOAuthStateFn              func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error)
	consumeOAuthStateFn             func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error)
	createLinearOAuthSetupFn        func(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error)
	deleteLinearOAuthSetupsByUserFn func(ctx context.Context, userID int64) error
	getLinearOAuthSetupByUserFn     func(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error)
	consumeLinearOAuthSetupByUserFn func(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error)
}

func (m *mockLinearIntegrationQuerier) CreateLinearIntegration(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
	return m.createLinearIntegrationFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) GetLinearIntegration(ctx context.Context, id int64) (db.LinearIntegration, error) {
	return m.getLinearIntegrationFn(ctx, id)
}

func (m *mockLinearIntegrationQuerier) GetLinearIntegrationByUserAndID(ctx context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
	return m.getLinearIntegrationByUserAndID(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) GetLinearIntegrationByLinearTeamID(ctx context.Context, linearTeamID string) (db.LinearIntegration, error) {
	return m.getLinearIntegrationByTeamIDFn(ctx, linearTeamID)
}

func (m *mockLinearIntegrationQuerier) ListLinearIntegrationsByUser(ctx context.Context, userID int64) ([]db.LinearIntegration, error) {
	return m.listLinearIntegrationsByUserFn(ctx, userID)
}

func (m *mockLinearIntegrationQuerier) ListLinearIntegrationsByRepo(ctx context.Context, repoID int64) ([]db.LinearIntegration, error) {
	return m.listLinearIntegrationsByRepoFn(ctx, repoID)
}

func (m *mockLinearIntegrationQuerier) ListActiveLinearIntegrations(ctx context.Context) ([]db.LinearIntegration, error) {
	return m.listActiveLinearIntegrationsFn(ctx)
}

func (m *mockLinearIntegrationQuerier) UpdateLinearIntegrationTokens(ctx context.Context, arg db.UpdateLinearIntegrationTokensParams) error {
	return m.updateLinearIntegrationTokensFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error {
	return m.updateLinearIntegrationLastSync(ctx, id)
}

func (m *mockLinearIntegrationQuerier) UpdateLinearIntegrationActive(ctx context.Context, arg db.UpdateLinearIntegrationActiveParams) error {
	return m.updateLinearIntegrationActiveFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) DeleteLinearIntegration(ctx context.Context, arg db.DeleteLinearIntegrationParams) error {
	return m.deleteLinearIntegrationFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) CreateOAuthState(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
	return m.createOAuthStateFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) ConsumeOAuthState(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
	return m.consumeOAuthStateFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) CreateLinearOAuthSetup(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
	return m.createLinearOAuthSetupFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) DeleteLinearOAuthSetupsByUser(ctx context.Context, userID int64) error {
	if m.deleteLinearOAuthSetupsByUserFn == nil {
		return nil
	}
	return m.deleteLinearOAuthSetupsByUserFn(ctx, userID)
}

func (m *mockLinearIntegrationQuerier) GetLinearOAuthSetupByUser(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
	return m.getLinearOAuthSetupByUserFn(ctx, arg)
}

func (m *mockLinearIntegrationQuerier) ConsumeLinearOAuthSetupByUser(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
	return m.consumeLinearOAuthSetupByUserFn(ctx, arg)
}

func TestLinearIntegrationService_OAuthSetupRoundTrip(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	var storedPayload []byte
	var storedUserID int64
	var storedKey string
	var storedExpiresAt time.Time
	var clearedUserID int64

	queries := &mockLinearIntegrationQuerier{
		deleteLinearOAuthSetupsByUserFn: func(ctx context.Context, userID int64) error {
			clearedUserID = userID
			return nil
		},
		createLinearOAuthSetupFn: func(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
			storedPayload = append([]byte(nil), arg.PayloadEncrypted...)
			storedUserID = arg.UserID
			storedKey = arg.SetupKey
			storedExpiresAt = arg.ExpiresAt
			return db.LinearOauthSetup{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: arg.PayloadEncrypted,
				CreatedAt:        now,
				ExpiresAt:        arg.ExpiresAt,
			}, nil
		},
		getLinearOAuthSetupByUserFn: func(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: storedPayload,
				CreatedAt:        now,
				ExpiresAt:        storedExpiresAt,
			}, nil
		},
		consumeLinearOAuthSetupByUserFn: func(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: storedPayload,
				CreatedAt:        now,
				ExpiresAt:        storedExpiresAt,
				UsedAt:           pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
			}, nil
		},
	}

	svc := NewLinearIntegrationService(queries, nil, "test-session-secret")
	svc.now = func() time.Time { return now }
	svc.generateSetupKey = func() (string, error) { return "setup-opaque-key", nil }

	input := LinearOAuthCallbackResult{
		AccessToken:  "access-token-secret",
		RefreshToken: "refresh-token-secret",
		ExpiresAt:    now.Add(time.Hour),
		Viewer: LinearViewer{
			ID:    "viewer-1",
			Name:  "Alice",
			Email: "alice@example.com",
		},
		Teams: []LinearTeam{
			{ID: "team-1", Name: "Platform", Key: "PLT"},
		},
	}

	setupKey, err := svc.CreateOAuthSetup(context.Background(), 77, input)
	require.NoError(t, err)
	assert.Equal(t, "setup-opaque-key", setupKey)
	assert.Equal(t, int64(77), clearedUserID)
	assert.Equal(t, int64(77), storedUserID)
	assert.Equal(t, "setup-opaque-key", storedKey)
	assert.Equal(t, now.Add(10*time.Minute), storedExpiresAt)
	assert.NotEmpty(t, storedPayload)
	assert.NotContains(t, string(storedPayload), "access-token-secret")
	assert.NotContains(t, string(storedPayload), "refresh-token-secret")

	setupResult, err := svc.GetOAuthSetup(context.Background(), 77, setupKey)
	require.NoError(t, err)
	assert.Equal(t, input.Teams, setupResult.Teams)
	assert.Equal(t, input.Viewer, setupResult.LinearActor)
	assert.Equal(t, storedExpiresAt, setupResult.ExpiresAt)
	setupResponseJSON, err := json.Marshal(setupResult)
	require.NoError(t, err)
	assert.NotContains(t, string(setupResponseJSON), "access-token-secret")
	assert.NotContains(t, string(setupResponseJSON), "refresh-token-secret")
	assert.Contains(t, string(setupResponseJSON), `"linear_actor":{"id":"viewer-1","email":"alice@example.com","name":"Alice"}`)

	consumedResult, err := svc.ConsumeOAuthSetup(context.Background(), 77, setupKey)
	require.NoError(t, err)
	assert.Equal(t, input, consumedResult)
}

func TestLinearIntegrationService_WebhookSecretEncryptedAtRest(t *testing.T) {
	t.Parallel()

	var stored db.CreateLinearIntegrationParams
	queries := &mockLinearIntegrationQuerier{
		createLinearIntegrationFn: func(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			stored = arg
			return db.LinearIntegration{ID: 1, WebhookSecret: arg.WebhookSecret}, nil
		},
	}

	svc := NewLinearIntegrationService(queries, nil, "test-session-secret")

	integration, err := svc.ConfigureIntegration(context.Background(), 42, ConfigureLinearIntegrationRequest{
		LinearTeamID: "team-1",
		AccessToken:  "linear-access",
		RepoID:       7,
	})
	require.NoError(t, err)

	// The persisted secret must not be a bare 64-hex plaintext value.
	assert.NotRegexp(t, `^[0-9a-f]{64}$`, stored.WebhookSecret, "webhook secret must not be stored as plaintext hex")
	assert.NotEmpty(t, stored.WebhookSecret)

	// It must round-trip back to a usable plaintext HMAC secret.
	plaintext, err := svc.GetDecryptedWebhookSecret(integration)
	require.NoError(t, err)
	assert.Len(t, plaintext, 64, "decrypted secret is the original 64-hex string")
	assert.Regexp(t, `^[0-9a-f]{64}$`, plaintext)

	// A legacy plaintext 64-hex row (not base64 ciphertext) must fail to decrypt.
	_, err = svc.GetDecryptedWebhookSecret(db.LinearIntegration{WebhookSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"})
	require.Error(t, err)
}

func TestLinearIntegrationService_StartLinearOAuth_RandomFailureDoesNotInsertState(t *testing.T) {
	oldReader := cryptorand.Reader
	cryptorand.Reader = failingLinearRandomReader{}
	t.Cleanup(func() { cryptorand.Reader = oldReader })

	createCalled := false
	queries := &mockLinearIntegrationQuerier{
		createOAuthStateFn: func(context.Context, db.CreateOAuthStateParams) (db.OauthState, error) {
			createCalled = true
			return db.OauthState{}, nil
		},
	}

	svc := NewLinearIntegrationService(queries, linearIntegrationHClient{}, "test-session-secret")
	redirectURL, err := svc.StartLinearOAuth(context.Background(), "verifier")
	require.Error(t, err)
	assert.Empty(t, redirectURL)
	assert.False(t, createCalled, "StartLinearOAuth must fail closed before persisting predictable state")
	assert.Contains(t, err.Error(), "failed to generate linear oauth state")
}

func TestLinearIntegrationService_CreateOAuthSetup_RandomFailureDoesNotReplaceSetup(t *testing.T) {
	oldReader := cryptorand.Reader
	cryptorand.Reader = failingLinearRandomReader{}
	t.Cleanup(func() { cryptorand.Reader = oldReader })

	oldEncrypt := linearIntegrationEncrypt
	linearIntegrationEncrypt = func(_ []byte, plaintext []byte) ([]byte, error) {
		return append([]byte(nil), plaintext...), nil
	}
	t.Cleanup(func() { linearIntegrationEncrypt = oldEncrypt })

	deleteCalled := false
	createCalled := false
	queries := &mockLinearIntegrationQuerier{
		deleteLinearOAuthSetupsByUserFn: func(context.Context, int64) error {
			deleteCalled = true
			return nil
		},
		createLinearOAuthSetupFn: func(context.Context, db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
			createCalled = true
			return db.LinearOauthSetup{}, nil
		},
	}

	svc := NewLinearIntegrationService(queries, nil, "test-session-secret")
	setupKey, err := svc.CreateOAuthSetup(context.Background(), 42, LinearOAuthCallbackResult{
		AccessToken: "linear-access",
		Viewer:      LinearViewer{ID: "viewer-1"},
	})
	require.Error(t, err)
	assert.Empty(t, setupKey)
	assert.False(t, deleteCalled, "CreateOAuthSetup must not replace existing setup rows with a predictable setup key")
	assert.False(t, createCalled, "CreateOAuthSetup must fail closed before inserting predictable setup keys")
	assert.Contains(t, err.Error(), "failed to generate linear oauth setup key")
}

func TestLinearIntegrationService_ConfigureIntegration_RandomFailureDoesNotInsert(t *testing.T) {
	oldReader := cryptorand.Reader
	cryptorand.Reader = failingLinearRandomReader{}
	t.Cleanup(func() { cryptorand.Reader = oldReader })

	oldEncrypt := linearIntegrationEncrypt
	linearIntegrationEncrypt = func(_ []byte, plaintext []byte) ([]byte, error) {
		return append([]byte(nil), plaintext...), nil
	}
	t.Cleanup(func() { linearIntegrationEncrypt = oldEncrypt })

	createCalled := false
	queries := &mockLinearIntegrationQuerier{
		createLinearIntegrationFn: func(context.Context, db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			createCalled = true
			return db.LinearIntegration{}, nil
		},
	}

	svc := NewLinearIntegrationService(queries, nil, "test-session-secret")
	integration, err := svc.ConfigureIntegration(context.Background(), 42, ConfigureLinearIntegrationRequest{
		LinearTeamID: "team-1",
		AccessToken:  "linear-access",
		RepoID:       7,
	})
	require.Error(t, err)
	assert.Equal(t, db.LinearIntegration{}, integration)
	assert.False(t, createCalled, "ConfigureIntegration must fail closed before inserting predictable webhook secrets")
	assert.Contains(t, err.Error(), "failed to generate linear webhook secret")
}
