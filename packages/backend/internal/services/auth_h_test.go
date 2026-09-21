package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
)

type authHInterfaceQuerier struct {
	AuthQuerier
}

type authHNoRefreshClient struct{}

func (authHNoRefreshClient) ExchangeCode(context.Context, string) (GitHubTokenResult, error) {
	return GitHubTokenResult{}, nil
}

func (authHNoRefreshClient) FetchUser(context.Context, string) (GitHubUserProfile, error) {
	return GitHubUserProfile{}, nil
}

func (authHNoRefreshClient) FetchEmails(context.Context, string) ([]GitHubEmail, error) {
	return nil, nil
}

func authHEncrypt(t *testing.T, secret, value string) []byte {
	t.Helper()
	encrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(secret), []byte(value))
	require.NoError(t, err)
	return encrypted
}

func TestAuth_H_KeyAuthOAuthStartAndClosedBetaBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(context.Context, db.ConsumeAuthNonceParams) (int64, error) {
			return 0, errors.New("consume failed")
		},
	}, cfg, mockKeyAuthVerifier{verifyFn: func(string, string, string) (string, string, error) {
		return "0xabc", "nonce", nil
	}}, nil)
	_, err := svc.VerifyKeyAuth(ctx, "message", "sig")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg.ClosedAlphaEnabled = true
	svc = NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(context.Context, db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(context.Context, pgtype.Text) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, errors.New("whitelist failed")
		},
	}, cfg, mockKeyAuthVerifier{verifyFn: func(string, string, string) (string, string, error) {
		return "0x1111111111111111111111111111111111111111", "nonce", nil
	}}, nil)
	_, err = svc.VerifyKeyAuth(ctx, "message", "sig")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		consumeAuthNonceFn: func(context.Context, db.ConsumeAuthNonceParams) (int64, error) {
			return 1, nil
		},
		getUserByWalletAddressFn: func(context.Context, pgtype.Text) (db.User, error) {
			return db.User{ID: 9, Username: "wallet", WalletAddress: pgtype.Text{String: "0x2222222222222222222222222222222222222222", Valid: true}}, nil
		},
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, nil
		},
	}, cfg, mockKeyAuthVerifier{verifyFn: func(string, string, string) (string, string, error) {
		return "0xabc", "nonce", nil
	}}, nil)
	_, err = svc.VerifyKeyAuth(ctx, "message", "sig")
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	auth0 := mockGitHubClient{authorizationURL: "https://auth0.test/authorize"}
	svc = NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, nil)
	svc.SetAuth0Client(auth0)
	_, err = svc.StartAuth0OAuth(ctx, " ")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(context.Context, db.CreateOAuthStateParams) (db.OauthState, error) {
			return db.OauthState{}, errors.New("state failed")
		},
	}, defaultAuthConfig(), nil, nil)
	svc.SetAuth0Client(auth0)
	_, err = svc.StartAuth0OAuth(ctx, "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), nil, nil)
	_, err = svc.CompleteAuth0OAuth(ctx, "code", "state", "verifier")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_WaitlistPromotionAndIdentityBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	cfg.ClosedAlphaEnabled = true
	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, nil)

	err := svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{Login: "octo"}, []GitHubEmail{{Email: "unverified@example.com", Verified: false}}, nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, errors.New("query failed")
		},
	}, cfg, nil, nil)
	err = svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{Login: "octo"}, []GitHubEmail{{Email: "ok@example.com", Verified: true}}, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		upsertWaitlistEntryFn: func(context.Context, db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, errors.New("insert failed")
		},
	}, cfg, nil, nil)
	err = svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{Login: "octo"}, []GitHubEmail{{Email: "ok@example.com", Verified: true}}, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Status: WaitlistStatusPending}, nil
		},
	}, cfg, nil, nil)
	err = svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{Login: "octo"}, []GitHubEmail{{Email: "ok@example.com", Verified: true}}, nil)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{}, cfg, nil, nil)
	err = svc.promoteApprovedWorkOSWaitlistEntry(ctx, "not-email", "octo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, errors.New("add failed")
		},
	}, cfg, nil, nil)
	err = svc.promoteApprovedWorkOSWaitlistEntry(ctx, "ok@example.com", "octo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	var checked []string
	svc = NewAuthService(&mockAuthQuerier{
		isWhitelistedIdentityFn: func(_ context.Context, arg db.IsWhitelistedIdentityParams) (bool, error) {
			checked = append(checked, arg.IdentityType+":"+arg.LowerIdentityValue)
			return arg.IdentityType == WhitelistIdentityWallet, nil
		},
	}, cfg, nil, nil)
	err = svc.enforceClosedBetaForUser(ctx, db.User{
		Username:      "octo",
		Email:         pgtype.Text{String: "octo@example.com", Valid: true},
		WalletAddress: pgtype.Text{String: "0x3333333333333333333333333333333333333333", Valid: true},
	}, nil)
	require.NoError(t, err)
	assert.Contains(t, checked, WhitelistIdentityEmail+":octo@example.com")
	assert.Contains(t, checked, WhitelistIdentityWallet+":0x3333333333333333333333333333333333333333")

	allowed, err := svc.isAnyClosedBetaIdentityWhitelisted(ctx, []closedAlphaIdentity{
		{identityType: "bad", identityValue: ""},
		{identityType: WhitelistIdentityEmail, identityValue: "dupe@example.com"},
		{identityType: WhitelistIdentityEmail, identityValue: "DUPE@example.com"},
	})
	require.NoError(t, err)
	assert.False(t, allowed)

	svc = NewAuthService(&mockAuthQuerier{
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, errors.New("whitelist query failed")
		},
	}, cfg, nil, nil)
	err = svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{}, nil, []closedAlphaIdentity{
		{identityType: WhitelistIdentityEmail, identityValue: "ok@example.com"},
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Status: WaitlistStatusApproved}, nil
		},
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, errors.New("promote failed")
		},
	}, cfg, nil, nil)
	err = svc.enforceWorkOSWaitlistAccess(ctx, GitHubUserProfile{Login: "octo"}, []GitHubEmail{{Email: "ok@example.com", Verified: true}}, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{}, cfg, nil, nil)
	require.NoError(t, svc.promoteApprovedWorkOSWaitlistEntry(ctx, "ok@example.com", " "))

	adds := 0
	svc = NewAuthService(&mockAuthQuerier{
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			adds++
			if adds == 2 {
				return db.AlphaWhitelistEntry{}, errors.New("second add failed")
			}
			return db.AlphaWhitelistEntry{}, nil
		},
	}, cfg, nil, nil)
	err = svc.promoteApprovedWorkOSWaitlistEntry(ctx, "ok@example.com", "octo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, errors.New("closed beta query failed")
		},
	}, cfg, nil, nil)
	err = svc.enforceClosedBetaForUser(ctx, db.User{Username: "octo"}, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_ResolveOAuthUserFailureBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 101, Login: "octo", Name: "Octo"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "   ", Verified: true}, {Email: "octo@example.com", Primary: true, Verified: true}}, nil
		},
	}

	svc := NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 5, AccessTokenEncrypted: []byte("not ciphertext")}, nil
		},
	}, cfg, nil, client)
	_, err := svc.resolveOAuthUser(ctx, client, "workos", "access", "", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg.ClosedAlphaEnabled = true
	encrypted := authHEncrypt(t, cfg.SessionSecret, "old")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{UserID: 5, AccessTokenEncrypted: encrypted}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 5, Username: "octo"}, nil
		},
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Status: WaitlistStatusPending}, nil
		},
	}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "", 0)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	cfg = defaultAuthConfig()
	cfg.SessionSecret = ""
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
			return db.User{ID: 6, Username: "octo"}, nil
		},
	}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	base := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
			return db.User{ID: 7, Username: "octo"}, nil
		},
		upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
			return db.UpsertEmailAddressRow{}, nil
		},
	}
	svc = NewAuthService(authHInterfaceQuerier{AuthQuerier: base}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	cfg.ClosedAlphaEnabled = true
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Status: WaitlistStatusApproved}, nil
		},
		createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
			return db.User{ID: 8, Username: "octo"}, nil
		},
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, nil
		},
	}, cfg, nil, client)
	_, err = svc.resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestAuth_H_ResolveOAuthUserMarshalAndEncryptSeams(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 404, Login: "seam", Name: "Seam"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "seam@example.com", Primary: true, Verified: true}}, nil
		},
	}
	base := func() *mockAuthQuerier {
		return &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, pgx.ErrNoRows
			},
			createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
				return db.User{ID: 404, Username: "seam"}, nil
			},
			upsertOAuthAccountFn: func(context.Context, db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			},
			upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			},
		}
	}

	oldMarshal := authJSONMarshal
	oldEncrypt := authEncrypt
	t.Cleanup(func() {
		authJSONMarshal = oldMarshal
		authEncrypt = oldEncrypt
	})
	authJSONMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal failed") }
	_, err := NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authJSONMarshal = oldMarshal

	authEncrypt = func([]byte, []byte) ([]byte, error) { return nil, errors.New("encrypt failed") }
	_, err = NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	calls := 0
	authEncrypt = func(key, plaintext []byte) ([]byte, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	_, err = NewAuthService(base(), cfg, nil, client).resolveOAuthUser(ctx, client, "workos", "access", "refresh", 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authEncrypt = oldEncrypt
}

func TestAuth_H_RefreshTokenAndCurrentTokenBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	account := db.OauthAccount{
		UserID:                8,
		Provider:              "workos",
		ProviderUserID:        "101",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "old-access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "old-refresh"),
	}

	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, authHNoRefreshClient{})
	_, err := svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = svc.oauthAccessTokenFromAccount(db.OauthAccount{AccessTokenEncrypted: []byte("bad")})
	require.Error(t, err)
	_, err = svc.oauthAccessTokenFromAccount(db.OauthAccount{AccessTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, " ")})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, pgx.ErrNoRows
		},
	}, cfg, nil, mockGitHubClient{})
	_, err = svc.currentOAuthAccessToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return db.OauthAccount{}, errors.New("query failed")
		},
	}, cfg, nil, mockGitHubClient{})
	_, err = svc.currentOAuthAccessToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	freshAccount := account
	freshAccount.AccessTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "fresh-access")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return freshAccount, nil
		},
	}, cfg, nil, mockGitHubClient{})
	got, err := svc.currentOAuthAccessToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-access", got)

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		clearOAuthAccountRefreshTokenCASFn: func(context.Context, db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
			return 0, errors.New("clear failed")
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
		rotateOAuthAccountTokensCASFn: func(context.Context, db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return 0, errors.New("persist failed")
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "new-access", got)

	cfg.SessionSecret = ""
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	cfg = defaultAuthConfig()
	changedBad := account
	changedBad.AccessTokenEncrypted = []byte("bad-current-access")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return changedBad, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "after-bad-current"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "after-bad-current", got)

	emptyRefresh := account
	emptyRefresh.RefreshTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, " ")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return emptyRefresh, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, emptyRefresh)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	for _, tc := range []struct {
		name string
		err  error
		code int
	}{
		{"gone", pgx.ErrNoRows, 401},
		{"query", errors.New("query failed"), 500},
	} {
		t.Run("invalid refresh reread "+tc.name, func(t *testing.T) {
			calls := 0
			svc := NewAuthService(&mockAuthQuerier{
				getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
					calls++
					if calls == 1 {
						return account, nil
					}
					return db.OauthAccount{}, tc.err
				},
			}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
				return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
			}})
			_, err := svc.RefreshUserGitHubToken(ctx, account)
			require.Error(t, err)
			assert.Equal(t, tc.code, apiStatus(t, err))
		})
	}

	freshAfterInvalid := account
	freshAfterInvalid.AccessTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "fresh-after-invalid")
	calls := 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls == 1 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	calls = 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls < 3 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
		clearOAuthAccountRefreshTokenCASFn: func(context.Context, db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
			return 0, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, ErrGitHubRefreshTokenInvalid
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: " "}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	calls = 0
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			calls++
			if calls < 2 {
				return account, nil
			}
			return freshAfterInvalid, nil
		},
		rotateOAuthAccountTokensCASFn: func(context.Context, db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return 0, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
	}})
	got, err = svc.RefreshUserGitHubToken(ctx, account)
	require.NoError(t, err)
	assert.Equal(t, "fresh-after-invalid", got)

	emptySecretCfg := defaultAuthConfig()
	emptySecretCfg.SessionSecret = ""
	emptySecretAccount := account
	emptySecretAccount.RefreshTokenEncrypted = authHEncrypt(t, "", "old-refresh")
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return emptySecretAccount, nil
		},
	}, emptySecretCfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, emptySecretAccount)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	oldEncrypt := authEncrypt
	t.Cleanup(func() { authEncrypt = oldEncrypt })
	authEncrypt = func([]byte, []byte) ([]byte, error) { return nil, errors.New("encrypt failed") }
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	calls = 0
	authEncrypt = func(key, plaintext []byte) ([]byte, error) {
		calls++
		if calls == 2 {
			return nil, errors.New("refresh encrypt failed")
		}
		return oldEncrypt(key, plaintext)
	}
	svc = NewAuthService(&mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access", RefreshToken: "new-refresh"}, nil
	}})
	_, err = svc.RefreshUserGitHubToken(ctx, account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	authEncrypt = oldEncrypt
}

func TestAuth_H_ExchangeRevokeRandomBranches(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()

	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, mockGitHubClient{})
	_, err := svc.ExchangeGitHubToken(ctx, " ", "name", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = NewAuthService(&mockAuthQuerier{}, cfg, nil, nil).RevokeUserSession(ctx, 1, " ")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	old := authRandRead
	authRandRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	t.Cleanup(func() { authRandRead = old })
	assert.Panics(t, func() { _ = randomHex(4) })
	assert.Panics(t, func() { _ = randomUUID() })

	authRandRead = func(buf []byte) (int, error) {
		for i := range buf {
			buf[i] = byte(i + 1)
		}
		return len(buf), nil
	}
	assert.Len(t, randomHex(2), 4)
	uuid := randomUUID()
	assert.Len(t, uuid, 36)
	assert.Equal(t, byte('4'), uuid[14])
	assert.Contains(t, "89ab", strings.ToLower(string(uuid[19])))
}

func TestAuth_H_ExchangeGitHubTokenRotationFailures(t *testing.T) {
	ctx := context.Background()
	cfg := defaultAuthConfig()
	client := mockGitHubClient{
		fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
			return GitHubUserProfile{ID: 303, Login: "worker", Name: "Worker"}, nil
		},
		fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
			return []GitHubEmail{{Email: "worker@example.com", Primary: true, Verified: true}}, nil
		},
	}
	base := func() *mockAuthQuerier {
		return &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, pgx.ErrNoRows
			},
			createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
				return db.User{ID: 303, Username: "worker"}, nil
			},
			upsertOAuthAccountPreserveRefreshFn: func(context.Context, db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			},
			upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			},
		}
	}

	q := base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{}, errors.New("create token failed")
	}
	_, err := NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)

	q = base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{ID: 10, UserID: 303, Name: "worker", TokenLastEight: "last8"}, nil
	}
	q.listAccessTokensByUserIDFn = func(context.Context, int64) ([]db.AccessToken, error) {
		return nil, errors.New("list tokens failed")
	}
	_, err = NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q = base()
	q.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{ID: 10, UserID: 303, Name: "worker", TokenLastEight: "last8"}, nil
	}
	q.listAccessTokensByUserIDFn = func(context.Context, int64) ([]db.AccessToken, error) {
		return []db.AccessToken{{ID: 9, UserID: 303, Name: "worker"}}, nil
	}
	q.deleteAccessTokenByIDAndUserIDFn = func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) {
		return 0, errors.New("delete failed")
	}
	_, err = NewAuthService(q, cfg, nil, client).ExchangeGitHubToken(ctx, "github-token", "worker", "", 0, nil)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_RefreshCASAbsentBranch(t *testing.T) {
	cfg := defaultAuthConfig()
	account := db.OauthAccount{
		UserID:                9,
		Provider:              "workos",
		ProviderUserID:        "101",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "old-access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "old-refresh"),
	}
	base := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return account, nil
		},
	}
	svc := NewAuthService(authHInterfaceQuerier{AuthQuerier: base}, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "new-access"}, nil
	}})
	_, err := svc.RefreshUserGitHubToken(context.Background(), account)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAuth_H_WaitlistApprovedPromotionUsernameSkip(t *testing.T) {
	cfg := defaultAuthConfig()
	cfg.ClosedAlphaEnabled = true
	svc := NewAuthService(&mockAuthQuerier{}, cfg, nil, nil)
	err := svc.enforceWorkOSWaitlistAccess(context.Background(), GitHubUserProfile{Login: " "}, []GitHubEmail{{Email: "ok@example.com", Verified: true}}, []closedAlphaIdentity{})
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	svc.now = func() time.Time { return time.Unix(100, 0).UTC() }
	assert.Equal(t, time.Unix(100, 0).UTC(), svc.now())
}
