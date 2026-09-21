package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// sha256HexOf mirrors the storage recipe the service must apply before
// persisting a session key.
func sha256HexOf(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// The session key is a live bearer credential (it is the session cookie's
// value), so the database must only ever store its SHA-256 digest — the same
// recipe already used for PATs, OAuth2 tokens, SSE tickets, and pair tokens.
// A read-only database compromise must not yield every active login.
func TestAuthService_VerifyKeyAuth_StoresSessionKeyHashedAtRest(t *testing.T) {
	t.Parallel()

	var stored db.CreateAuthSessionParams
	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(ctx context.Context, arg db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(ctx context.Context, walletAddress pgtype.Text) (db.User, error) {
			return db.User{ID: 99, Username: "wallet-user", LowerUsername: "wallet-user", IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			stored = arg
			return db.AuthSession{
				SessionKey: arg.SessionKey,
				UserID:     arg.UserID,
				Username:   arg.Username,
				ExpiresAt:  arg.ExpiresAt,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{
		verifyFn: func(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
			return "0x1234567890123456789012345678901234567890", "nonce-1", nil
		},
	}, mockGitHubClient{})

	result, err := svc.VerifyKeyAuth(context.Background(), "message", "signature")
	require.NoError(t, err)
	require.NotEmpty(t, result.SessionKey)
	// The caller receives the raw key; the database must hold only its digest.
	assert.NotEqual(t, result.SessionKey, stored.SessionKey,
		"session key must not be stored verbatim")
	assert.Equal(t, sha256HexOf(result.SessionKey), stored.SessionKey,
		"stored session key must be the SHA-256 digest of the issued key")
}

func TestAuthService_CompleteGitHubOAuth_StoresSessionKeyHashedAtRest(t *testing.T) {
	t.Parallel()

	var stored db.CreateAuthSessionParams
	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateWithScopesFn: func(ctx context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error) {
			return nil, nil
		},
		getOAuthAccountByProviderUserIDFn: func(ctx context.Context, arg db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 42, Username: arg.Username, LowerUsername: arg.LowerUsername, IsActive: true}, nil
		},
		createAuthSessionFn: func(ctx context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			stored = arg
			return db.AuthSession{
				SessionKey: arg.SessionKey,
				UserID:     arg.UserID,
				Username:   arg.Username,
				ExpiresAt:  arg.ExpiresAt,
			}, nil
		},
		upsertOAuthAccountPreserveRefreshFn: func(ctx context.Context, arg db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_test"}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 4242, Login: "octouser"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	})

	result, err := svc.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.NoError(t, err)
	require.NotEmpty(t, result.SessionKey)
	assert.NotEqual(t, result.SessionKey, stored.SessionKey,
		"session key must not be stored verbatim")
	assert.Equal(t, sha256HexOf(result.SessionKey), stored.SessionKey,
		"stored session key must be the SHA-256 digest of the issued key")
}

// Logout must delete the session under its hashed storage key AND under the
// legacy raw key (rows minted before keys were hashed at rest stay raw-keyed
// until they expire).
func TestAuthService_Logout_DeletesHashedAndLegacySessionKeys(t *testing.T) {
	t.Parallel()

	raw := "550e8400-e29b-41d4-a716-446655440000"
	var deleted []string
	svc := NewAuthService(&mockAuthQuerier{
		deleteAuthSessionFn: func(ctx context.Context, sessionKey string) error {
			deleted = append(deleted, sessionKey)
			return nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	require.NoError(t, svc.Logout(context.Background(), raw))
	assert.Contains(t, deleted, sha256HexOf(raw), "logout must delete the hashed storage form")
	assert.Contains(t, deleted, raw, "logout must still delete the legacy raw-keyed form")
}
