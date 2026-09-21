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
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type linearIntegrationCovClient struct {
	authorizationURLFn func(state string) string
	exchangeCodeFn     func(ctx context.Context, code string) (LinearTokenResult, error)
	refreshTokenFn     func(ctx context.Context, refreshToken string) (LinearTokenResult, error)
	fetchViewerFn      func(ctx context.Context, accessToken string) (LinearViewer, error)
	fetchTeamsFn       func(ctx context.Context, accessToken string) ([]LinearTeam, error)
}

func (c linearIntegrationCovClient) AuthorizationURL(state string) string {
	if c.authorizationURLFn != nil {
		return c.authorizationURLFn(state)
	}
	return "https://linear.test/oauth?state=" + state
}

func (c linearIntegrationCovClient) ExchangeCode(ctx context.Context, code string) (LinearTokenResult, error) {
	return c.exchangeCodeFn(ctx, code)
}

func (c linearIntegrationCovClient) RefreshToken(ctx context.Context, refreshToken string) (LinearTokenResult, error) {
	return c.refreshTokenFn(ctx, refreshToken)
}

func (c linearIntegrationCovClient) FetchViewer(ctx context.Context, accessToken string) (LinearViewer, error) {
	return c.fetchViewerFn(ctx, accessToken)
}

func (c linearIntegrationCovClient) FetchTeams(ctx context.Context, accessToken string) ([]LinearTeam, error) {
	return c.fetchTeamsFn(ctx, accessToken)
}

func TestLinearIntegration_Cov_OAuthStartCompleteAndSetupErrors(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)

	svc := NewLinearIntegrationService(&mockLinearIntegrationQuerier{}, nil, "linear-secret")
	_, err := svc.StartLinearOAuth(ctx, "verifier")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 400)

	var created db.CreateOAuthStateParams
	var seenState string
	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		createOAuthStateFn: func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			created = arg
			return db.OauthState{StateKey: arg.State, ExpiresAt: arg.ExpiresAt}, nil
		},
	}, linearIntegrationCovClient{
		authorizationURLFn: func(state string) string {
			seenState = state
			return "https://linear.test/start?state=" + state
		},
	}, "linear-secret")
	svc.now = func() time.Time { return now }
	url, err := svc.StartLinearOAuth(ctx, " verifier ")
	require.NoError(t, err)
	assert.Equal(t, "https://linear.test/start?state="+seenState, url)
	assert.Equal(t, seenState, created.State)
	assert.Equal(t, hashSHA256(" verifier "), created.ContextHash)
	assert.Equal(t, now.Add(10*time.Minute), created.ExpiresAt)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) {
			return 0, nil
		},
	}, linearIntegrationCovClient{}, "linear-secret")
	_, err = svc.CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 400)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) {
			return 1, nil
		},
	}, linearIntegrationCovClient{
		exchangeCodeFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{}, errors.New("bad code")
		},
	}, "linear-secret")
	_, err = svc.CompleteLinearOAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 500)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		consumeOAuthStateFn: func(_ context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			assert.Equal(t, "state-ok", arg.State)
			assert.Equal(t, hashSHA256("verifier-ok"), arg.ContextHash)
			return 1, nil
		},
	}, linearIntegrationCovClient{
		exchangeCodeFn: func(context.Context, string) (LinearTokenResult, error) {
			return LinearTokenResult{AccessToken: "linear-access", RefreshToken: "linear-refresh", ExpiresAt: now.Add(time.Hour)}, nil
		},
		fetchViewerFn: func(_ context.Context, token string) (LinearViewer, error) {
			assert.Equal(t, "linear-access", token)
			return LinearViewer{ID: "viewer-1", Email: "viewer@example.com", Name: "Viewer"}, nil
		},
		fetchTeamsFn: func(context.Context, string) ([]LinearTeam, error) {
			return []LinearTeam{{ID: "team-1", Name: "Platform", Key: "PLT"}}, nil
		},
	}, "linear-secret")
	result, err := svc.CompleteLinearOAuth(ctx, "code-ok", "state-ok", "verifier-ok")
	require.NoError(t, err)
	assert.Equal(t, "viewer-1", result.Viewer.ID)
	require.Len(t, result.Teams, 1)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		getLinearOAuthSetupByUserFn: func(context.Context, db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{}, pgx.ErrNoRows
		},
		consumeLinearOAuthSetupByUserFn: func(context.Context, db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{}, pgx.ErrNoRows
		},
	}, nil, "linear-secret")
	_, err = svc.GetOAuthSetup(ctx, 1, "missing")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 404)
	_, err = svc.ConsumeOAuthSetup(ctx, 1, "missing")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 404)

	svc = NewLinearIntegrationService(&mockLinearIntegrationQuerier{
		getLinearOAuthSetupByUserFn: func(context.Context, db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			return db.LinearOauthSetup{PayloadEncrypted: []byte("not-ciphertext")}, nil
		},
	}, nil, "linear-secret")
	_, err = svc.GetOAuthSetup(ctx, 1, "bad")
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 500)
}

func TestLinearIntegration_Cov_IntegrationForwardingTokensAndRefresh(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	var created db.CreateLinearIntegrationParams
	var updated db.UpdateLinearIntegrationTokensParams
	var deleted db.DeleteLinearIntegrationParams
	queries := &mockLinearIntegrationQuerier{
		createLinearIntegrationFn: func(_ context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			created = arg
			return db.LinearIntegration{
				ID:                    10,
				UserID:                arg.UserID,
				LinearTeamID:          arg.LinearTeamID,
				AccessTokenEncrypted:  arg.AccessTokenEncrypted,
				RefreshTokenEncrypted: arg.RefreshTokenEncrypted,
				TokenExpiresAt:        arg.TokenExpiresAt,
				WebhookSecret:         arg.WebhookSecret,
				JjhubRepoID:           arg.JjhubRepoID,
				JjhubRepoOwner:        arg.JjhubRepoOwner,
				JjhubRepoName:         arg.JjhubRepoName,
				IsActive:              true,
			}, nil
		},
		listLinearIntegrationsByUserFn: func(context.Context, int64) ([]db.LinearIntegration, error) {
			return []db.LinearIntegration{{ID: 10}}, nil
		},
		getLinearIntegrationByUserAndID: func(context.Context, db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
			return db.LinearIntegration{ID: 10}, nil
		},
		getLinearIntegrationByTeamIDFn: func(context.Context, string) (db.LinearIntegration, error) {
			return db.LinearIntegration{ID: 10, LinearTeamID: "team-1"}, nil
		},
		listLinearIntegrationsByRepoFn: func(context.Context, int64) ([]db.LinearIntegration, error) {
			return []db.LinearIntegration{{ID: 10, JjhubRepoID: 99}}, nil
		},
		deleteLinearIntegrationFn: func(_ context.Context, arg db.DeleteLinearIntegrationParams) error {
			deleted = arg
			return nil
		},
		updateLinearIntegrationTokensFn: func(_ context.Context, arg db.UpdateLinearIntegrationTokensParams) error {
			updated = arg
			return nil
		},
	}
	client := linearIntegrationCovClient{
		refreshTokenFn: func(_ context.Context, refresh string) (LinearTokenResult, error) {
			assert.Equal(t, "old-refresh", refresh)
			return LinearTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresAt: now.Add(time.Hour)}, nil
		},
	}
	svc := NewLinearIntegrationService(queries, client, "linear-secret")
	svc.now = func() time.Time { return now }

	integration, err := svc.ConfigureIntegration(ctx, 7, ConfigureLinearIntegrationRequest{
		LinearTeamID:   "team-1",
		LinearTeamName: "Platform",
		LinearTeamKey:  "PLT",
		RepoOwner:      "alice",
		RepoName:       "demo",
		RepoID:         99,
		AccessToken:    "linear-access",
		RefreshToken:   "old-refresh",
		ExpiresAt:      now.Add(time.Minute),
		LinearActorID:  "actor-1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(7), created.UserID)
	assert.NotEqual(t, []byte("linear-access"), created.AccessTokenEncrypted)
	assert.Equal(t, "linear-access", linearIntegrationCovDecrypt(t, "linear-secret", integration.AccessTokenEncrypted))

	access, err := svc.GetDecryptedAccessToken(ctx, integration)
	require.NoError(t, err)
	assert.Equal(t, "linear-access", access)
	_, err = svc.GetDecryptedAccessToken(ctx, db.LinearIntegration{})
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 500)
	_, err = svc.GetDecryptedWebhookSecret(db.LinearIntegration{})
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 500)

	listed, err := svc.ListIntegrations(ctx, 7)
	require.NoError(t, err)
	assert.Len(t, listed, 1)
	got, err := svc.GetIntegration(ctx, 7, 10)
	require.NoError(t, err)
	assert.Equal(t, int64(10), got.ID)
	byTeam, err := svc.GetIntegrationByLinearTeamID(ctx, "team-1")
	require.NoError(t, err)
	assert.Equal(t, "team-1", byTeam.LinearTeamID)
	byRepo, err := svc.ListIntegrationsByRepo(ctx, 99)
	require.NoError(t, err)
	assert.Len(t, byRepo, 1)
	require.NoError(t, svc.DeleteIntegration(ctx, 7, 10))
	assert.Equal(t, db.DeleteLinearIntegrationParams{ID: 10, UserID: 7}, deleted)

	noExpiry, err := svc.RefreshTokenIfNeeded(ctx, db.LinearIntegration{ID: 1})
	require.NoError(t, err)
	assert.Equal(t, int64(1), noExpiry.ID)
	future := integration
	future.TokenExpiresAt = pgtype.Timestamptz{Time: now.Add(30 * time.Minute), Valid: true}
	unchanged, err := svc.RefreshTokenIfNeeded(ctx, future)
	require.NoError(t, err)
	assert.Equal(t, future.AccessTokenEncrypted, unchanged.AccessTokenEncrypted)
	noRefresh := integration
	noRefresh.RefreshTokenEncrypted = nil
	noRefresh.TokenExpiresAt = pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true}
	unchanged, err = svc.RefreshTokenIfNeeded(ctx, noRefresh)
	require.NoError(t, err)
	assert.Nil(t, unchanged.RefreshTokenEncrypted)

	refreshed, err := svc.RefreshTokenIfNeeded(ctx, integration)
	require.NoError(t, err)
	assert.Equal(t, int64(10), updated.ID)
	assert.Equal(t, "new-access", linearIntegrationCovDecrypt(t, "linear-secret", updated.AccessTokenEncrypted))
	assert.Equal(t, "new-refresh", linearIntegrationCovDecrypt(t, "linear-secret", updated.RefreshTokenEncrypted))
	assert.Equal(t, "new-access", linearIntegrationCovDecrypt(t, "linear-secret", refreshed.AccessTokenEncrypted))

	badCipher := integration
	badCipher.RefreshTokenEncrypted = []byte("bad")
	_, err = svc.RefreshTokenIfNeeded(ctx, badCipher)
	require.Error(t, err)
	linearIntegrationCovAssertAPIStatus(t, err, 500)

	assert.Equal(t, hashSHA256("same"), hashSHA256("same"))
	assert.NotEqual(t, hashSHA256("same"), hashSHA256("other"))
}

func linearIntegrationCovDecrypt(t *testing.T, secret string, ciphertext []byte) string {
	t.Helper()
	plaintext, err := smitherscrypto.Decrypt(smitherscrypto.DeriveKey(secret), ciphertext)
	require.NoError(t, err)
	return string(plaintext)
}

func linearIntegrationCovAssertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}
