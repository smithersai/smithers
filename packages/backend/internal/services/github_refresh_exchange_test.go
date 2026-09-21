package services

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// exchangeAccountStoreT is a tiny stateful stand-in for the single
// oauth_accounts row that the trusted-worker exchange resolves/updates and that
// RefreshUserGitHubToken later reads and rotates. It models the ONE fact this
// bug turns on: a user whose only login path is the multi worker exchange never
// gets a refresh token persisted, so when the ~8h GitHub App access token
// expires there is nothing to refresh with and every GitHub-backed call 401s.
//
// GetOAuthAccountByProviderUserID returns the current snapshot (or ErrNoRows
// before the first upsert, driving the new-user branch of resolveOAuthUser).
// UpsertOAuthAccount overwrites the pair (the non-empty-refresh-token branch);
// UpsertOAuthAccountPreserveRefresh writes only the access token, keeping the
// stored refresh ciphertext (the empty-refresh-token branch, i.e. today's
// behavior). RotateOAuthAccountTokensCAS performs a real CAS keyed on the stale
// access ciphertext.
type exchangeAccountStoreT struct {
	mu      sync.Mutex
	present bool
	account db.OauthAccount
}

func (s *exchangeAccountStoreT) get() (db.OauthAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.present {
		return db.OauthAccount{}, pgx.ErrNoRows
	}
	return s.account, nil
}

func (s *exchangeAccountStoreT) upsert(arg db.UpsertOAuthAccountParams) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.present = true
	s.account = db.OauthAccount{
		UserID:                arg.UserID,
		Provider:              arg.Provider,
		ProviderUserID:        arg.ProviderUserID,
		AccessTokenEncrypted:  arg.AccessTokenEncrypted,
		RefreshTokenEncrypted: arg.RefreshTokenEncrypted,
		ProfileData:           arg.ProfileData,
	}
}

func (s *exchangeAccountStoreT) upsertPreserveRefresh(arg db.UpsertOAuthAccountPreserveRefreshParams) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.present = true
	s.account.UserID = arg.UserID
	s.account.Provider = arg.Provider
	s.account.ProviderUserID = arg.ProviderUserID
	s.account.AccessTokenEncrypted = arg.AccessTokenEncrypted
	s.account.ProfileData = arg.ProfileData
	// RefreshTokenEncrypted intentionally left untouched — this is the SQL
	// UpsertOAuthAccountPreserveRefresh contract the browser flow relies on.
}

func (s *exchangeAccountStoreT) cas(newAccess, newRefresh, oldAccess []byte) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if string(s.account.AccessTokenEncrypted) != string(oldAccess) {
		return 0
	}
	s.account.AccessTokenEncrypted = newAccess
	s.account.RefreshTokenEncrypted = newRefresh
	return 1
}

// exchangeRefreshQuerier wires a mockAuthQuerier over a stateful account store
// plus the token-rotation plumbing ExchangeGitHubToken needs (mint/list/delete).
func exchangeRefreshQuerier(store *exchangeAccountStoreT) *mockAuthQuerier {
	return &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return store.get()
		},
		createUserFn: func(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
			return db.User{ID: 501, Username: arg.Username}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "octo"}, nil
		},
		upsertOAuthAccountFn: func(ctx context.Context, arg db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
			store.upsert(arg)
			return store.account, nil
		},
		upsertOAuthAccountPreserveRefreshFn: func(ctx context.Context, arg db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
			store.upsertPreserveRefresh(arg)
			return store.account, nil
		},
		upsertEmailAddressFn: func(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
		listAccessTokensByUserIDFn: func(ctx context.Context, userID int64) ([]db.AccessToken, error) {
			return nil, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 10, UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt}, nil
		},
		rotateOAuthAccountTokensCASFn: func(_ context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return store.cas(arg.AccessTokenEncrypted, arg.RefreshTokenEncrypted, arg.OldAccessTokenEncrypted), nil
		},
	}
}

func exchangeRefreshGitHubClient() mockGitHubClient {
	return mockGitHubClient{
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 777, Login: "octo", Name: "Octo Cat"}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
		refreshTokenFn: func(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
			return GitHubTokenResult{AccessToken: "gho_refreshed_access", RefreshToken: "ghr_rotated_refresh"}, nil
		},
	}
}

// TestAuthService_ExchangeGitHubToken_StoresIncomingRefreshToken is the primary
// RED test for the 8-hour multi-session death: a worker-only user (never went
// through browser OAuth on plue) logs in via the trusted-worker exchange. The
// exchange now carries the GitHub refresh token GitHub minted during THIS login;
// it must land in the same encrypted oauth_accounts field the browser flow uses,
// so that when the ~8h access token expires RefreshUserGitHubToken has something
// to refresh with instead of 401'ing forever. Fails today: ExchangeGitHubToken
// forwards only the access token and hardcodes an empty refresh token.
func TestAuthService_ExchangeGitHubToken_StoresIncomingRefreshToken(t *testing.T) {
	t.Parallel()

	store := &exchangeAccountStoreT{}
	svc := NewAuthService(exchangeRefreshQuerier(store), defaultAuthConfig(), nil, exchangeRefreshGitHubClient())

	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_login_access", "multi-worker", "ghr_from_login", 0, nil)
	require.NoError(t, err)

	stored, err := store.get()
	require.NoError(t, err)
	require.NotEmpty(t, stored.RefreshTokenEncrypted, "the incoming GitHub refresh token must be persisted, encrypted")
	decrypted, err := svc.DecryptOAuthAccessToken(stored.RefreshTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, "ghr_from_login", decrypted, "the stored refresh token must be the one minted during this login")

	// The whole point: a later refresh against the freshly stored row succeeds.
	access, err := svc.RefreshUserGitHubToken(context.Background(), stored)
	require.NoError(t, err, "with a stored refresh token, the ~8h expiry must be refreshable instead of 401'ing")
	assert.Equal(t, "gho_refreshed_access", access)
}

// TestAuthService_ExchangeGitHubToken_EmptyRefreshTokenPreservesStored is the
// regression guard: an exchange WITHOUT a refresh token (absent/empty) must
// behave exactly as today — a previously stored refresh token is preserved via
// the preserve-refresh upsert, and no error is raised.
func TestAuthService_ExchangeGitHubToken_EmptyRefreshTokenPreservesStored(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	store := &exchangeAccountStoreT{
		present: true,
		account: db.OauthAccount{
			UserID:                42,
			Provider:              "workos",
			ProviderUserID:        "777",
			AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_old_access"),
			RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_previously_stored"),
		},
	}
	svc := NewAuthService(exchangeRefreshQuerier(store), cfg, nil, exchangeRefreshGitHubClient())

	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_login_access", "multi-worker", "", 0, nil)
	require.NoError(t, err)

	stored, err := store.get()
	require.NoError(t, err)
	decrypted, err := svc.DecryptOAuthAccessToken(stored.RefreshTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, "ghr_previously_stored", decrypted, "an empty incoming refresh token must preserve the stored one, exactly like today")
}

// TestAuthService_ExchangeGitHubToken_IncomingRefreshTokenOverwritesOlder proves
// the newer-by-construction rule: the incoming (access, refresh) pair was just
// minted by GitHub during this login, so a NON-EMPTY incoming refresh token must
// overwrite whatever older refresh token was stored.
func TestAuthService_ExchangeGitHubToken_IncomingRefreshTokenOverwritesOlder(t *testing.T) {
	t.Parallel()

	cfg := defaultAuthConfig()
	store := &exchangeAccountStoreT{
		present: true,
		account: db.OauthAccount{
			UserID:                42,
			Provider:              "workos",
			ProviderUserID:        "777",
			AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_old_access"),
			RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_older_stored"),
		},
	}
	svc := NewAuthService(exchangeRefreshQuerier(store), cfg, nil, exchangeRefreshGitHubClient())

	_, err := svc.ExchangeGitHubToken(context.Background(), "gho_login_access", "multi-worker", "ghr_newer_from_login", 0, nil)
	require.NoError(t, err)

	stored, err := store.get()
	require.NoError(t, err)
	decrypted, err := svc.DecryptOAuthAccessToken(stored.RefreshTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, "ghr_newer_from_login", decrypted, "a non-empty incoming refresh token (freshly minted this login) must win over the older stored one")
}
