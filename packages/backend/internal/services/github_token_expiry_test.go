package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHub App user-to-server access tokens live ~8h and arrive with expires_in.
const githubAccessTokenLifetime = 8 * time.Hour

// expiryStoreT is refreshStoreT plus the two things the expiry work added: the
// expires_at column, and a compare-and-swap that models the REAL SQL predicate
// (matching on BOTH ciphertexts) rather than access alone. Keeping the refresh
// column in the predicate is what makes the cross-replica race reproducible.
type expiryStoreT struct {
	mu      sync.Mutex
	account db.OauthAccount
	reads   int64
	// onRead, when set, runs after each read and may mutate the row — the seam
	// used to interleave a concurrent replica's write at an exact instant.
	onRead func(store *expiryStoreT, read int64)
}

func (s *expiryStoreT) get() db.OauthAccount {
	s.mu.Lock()
	account := s.account
	n := atomic.AddInt64(&s.reads, 1)
	hook := s.onRead
	s.mu.Unlock()
	if hook != nil {
		hook(s, n)
	}
	return account
}

func (s *expiryStoreT) set(account db.OauthAccount) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.account = account
}

func (s *expiryStoreT) snapshot() db.OauthAccount {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.account
}

// casBoth mirrors RotateOAuthAccountTokensCAS: rotate only when BOTH stored
// ciphertexts still equal the caller's stale pair.
func (s *expiryStoreT) casBoth(arg db.RotateOAuthAccountTokensCASParams) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if string(s.account.AccessTokenEncrypted) != string(arg.OldAccessTokenEncrypted) ||
		string(s.account.RefreshTokenEncrypted) != string(arg.OldRefreshTokenEncrypted) {
		return 0
	}
	s.account.AccessTokenEncrypted = arg.AccessTokenEncrypted
	s.account.RefreshTokenEncrypted = arg.RefreshTokenEncrypted
	s.account.ExpiresAt = arg.ExpiresAt
	return 1
}

// casByAccess mirrors RotateOAuthAccountTokensByAccessCAS: the heal statement,
// which deliberately ignores the refresh column.
func (s *expiryStoreT) casByAccess(arg db.RotateOAuthAccountTokensByAccessCASParams) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if string(s.account.AccessTokenEncrypted) != string(arg.OldAccessTokenEncrypted) {
		return 0
	}
	s.account.AccessTokenEncrypted = arg.AccessTokenEncrypted
	s.account.RefreshTokenEncrypted = arg.RefreshTokenEncrypted
	s.account.ExpiresAt = arg.ExpiresAt
	return 1
}

type expiryHarness struct {
	svc           *AuthService
	store         *expiryStoreT
	sessionSecret string
	refreshHits   *int64
	clearedCalls  *int64
	now           time.Time
}

// newExpiryHarness wires a real *AuthService over expiryStoreT. refreshResult
// decides what "GitHub" returns for each refresh attempt.
func newExpiryHarness(
	t *testing.T,
	account db.OauthAccount,
	refreshResult func(hit int64, refreshToken string) (GitHubTokenResult, error),
) *expiryHarness {
	t.Helper()
	cfg := defaultAuthConfig()
	store := &expiryStoreT{account: account}
	var refreshHits, clearedCalls int64

	client := mockGitHubClient{
		refreshTokenFn: func(_ context.Context, refreshToken string) (GitHubTokenResult, error) {
			hit := atomic.AddInt64(&refreshHits, 1)
			return refreshResult(hit, refreshToken)
		},
	}

	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return store.get(), nil
		},
		rotateOAuthAccountTokensCASFn: func(_ context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return store.casBoth(arg), nil
		},
		rotateOAuthAccountTokensByAccessFn: func(_ context.Context, arg db.RotateOAuthAccountTokensByAccessCASParams) (int64, error) {
			return store.casByAccess(arg), nil
		},
		clearOAuthAccountRefreshTokenCASFn: func(_ context.Context, arg db.ClearOAuthAccountRefreshTokenCASParams) (int64, error) {
			atomic.AddInt64(&clearedCalls, 1)
			store.mu.Lock()
			defer store.mu.Unlock()
			if string(store.account.AccessTokenEncrypted) != string(arg.OldAccessTokenEncrypted) ||
				string(store.account.RefreshTokenEncrypted) != string(arg.OldRefreshTokenEncrypted) {
				return 0, nil
			}
			store.account.RefreshTokenEncrypted = nil
			return 1, nil
		},
	}

	svc := NewAuthService(querier, cfg, nil, client)
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }

	return &expiryHarness{
		svc:           svc,
		store:         store,
		sessionSecret: cfg.SessionSecret,
		refreshHits:   &refreshHits,
		clearedCalls:  &clearedCalls,
		now:           now,
	}
}

func (h *expiryHarness) decrypt(t *testing.T, ciphertext []byte) string {
	t.Helper()
	plain, err := h.svc.DecryptOAuthAccessToken(ciphertext)
	require.NoError(t, err)
	return plain
}

func rotatingRefresh(hit int64, _ string) (GitHubTokenResult, error) {
	return GitHubTokenResult{
		AccessToken:           fmt.Sprintf("gho_fresh_%d", hit),
		RefreshToken:          fmt.Sprintf("ghr_fresh_%d", hit),
		ExpiresIn:             int64(githubAccessTokenLifetime / time.Second),
		RefreshTokenExpiresIn: int64((6 * 30 * 24 * time.Hour) / time.Second),
	}, nil
}

// account builds an oauth_accounts row with the given persisted expiry. A zero
// expiresAt models every row written before expiry was persisted at all.
func (h *expiryHarness) seedAccount(t *testing.T, access, refresh string, expiresAt time.Time) db.OauthAccount {
	t.Helper()
	acct := db.OauthAccount{
		UserID:                42,
		Provider:              "github",
		ProviderUserID:        "gh-42",
		AccessTokenEncrypted:  authHEncrypt(t, h.sessionSecret, access),
		RefreshTokenEncrypted: authHEncrypt(t, h.sessionSecret, refresh),
	}
	if !expiresAt.IsZero() {
		acct.ExpiresAt = pgtype.Timestamptz{Time: expiresAt, Valid: true}
	}
	h.store.set(acct)
	return acct
}

// TestGitHubRefresh_PersistsRotatedRefreshTokenAndExpiry is the core of the fix.
// GitHub rotates the refresh token on every exchange and reports the new access
// token's expires_in. Persisting only the access token — which is what happened
// before expiry was written — leaves expires_at NULL forever, so no caller can
// ever refresh proactively and every 8h cycle costs a guaranteed failed request.
func TestGitHubRefresh_PersistsRotatedRefreshTokenAndExpiry(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
	stale := h.seedAccount(t, "gho_stale", "ghr_stale", time.Time{})

	token, err := h.svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.Equal(t, "gho_fresh_1", token)

	stored := h.store.snapshot()
	assert.Equal(t, "gho_fresh_1", h.decrypt(t, stored.AccessTokenEncrypted))
	assert.Equal(t, "ghr_fresh_1", h.decrypt(t, stored.RefreshTokenEncrypted),
		"the ROTATED refresh token must replace the spent one, or the chain dies at the next refresh")

	require.True(t, stored.ExpiresAt.Valid, "expires_at must be persisted so the next call can refresh proactively")
	assert.Equal(t, h.now.Add(githubAccessTokenLifetime), stored.ExpiresAt.Time.UTC())
}

// TestGitHubRefresh_OmittedExpiresInStoresNullExpiry keeps us honest: when the
// App does not have expiring user tokens enabled GitHub sends no expires_in, and
// we must store NULL rather than invent a deadline that would cause needless
// refreshes of a token that never expires.
func TestGitHubRefresh_OmittedExpiresInStoresNullExpiry(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, func(hit int64, _ string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "gho_no_expiry", RefreshToken: "ghr_no_expiry"}, nil
	})
	stale := h.seedAccount(t, "gho_stale", "ghr_stale", time.Time{})

	_, err := h.svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.False(t, h.store.snapshot().ExpiresAt.Valid, "no expires_in from GitHub must leave expires_at NULL")
}

// TestGitHubRefresh_ProactiveRefreshBeforeTheCallIsSpent covers the user-visible
// win: with a persisted expiry, an expired token is renewed BEFORE it is used, so
// the caller never spends a doomed request. This is what rescues callers that
// cannot classify their own failure as a 401 — notably `git clone`, which just
// exits non-zero.
func TestGitHubRefresh_ProactiveRefreshBeforeTheCallIsSpent(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name        string
		expiresAt   func(now time.Time) time.Time
		wantToken   string
		wantGitHub  int64
		description string
	}{
		{
			name:        "already expired",
			expiresAt:   func(now time.Time) time.Time { return now.Add(-time.Minute) },
			wantToken:   "gho_fresh_1",
			wantGitHub:  1,
			description: "a token past its recorded expiry must be renewed before use",
		},
		{
			name:        "inside the skew window",
			expiresAt:   func(now time.Time) time.Time { return now.Add(githubTokenRefreshSkew / 2) },
			wantToken:   "gho_fresh_1",
			wantGitHub:  1,
			description: "a token about to expire mid-request must be renewed before use",
		},
		{
			name:        "comfortably valid",
			expiresAt:   func(now time.Time) time.Time { return now.Add(githubAccessTokenLifetime) },
			wantToken:   "gho_current",
			wantGitHub:  0,
			description: "a healthy token must never trigger a refresh",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
			acct := h.seedAccount(t, "gho_current", "ghr_current", tc.expiresAt(h.now))

			token, err := h.svc.RefreshUserGitHubTokenIfExpiring(context.Background(), acct, "gho_current")
			require.NoError(t, err)
			assert.Equal(t, tc.wantToken, token, tc.description)
			assert.Equal(t, tc.wantGitHub, atomic.LoadInt64(h.refreshHits), tc.description)
		})
	}
}

// TestGitHubRefresh_NullExpiryKeepsReactiveBehavior is the backward-compatibility
// guarantee. Every oauth_accounts row that predates this change carries a NULL
// expires_at; those rows must keep working exactly as before (reactive on 401)
// instead of being refreshed blindly on every single request.
func TestGitHubRefresh_NullExpiryKeepsReactiveBehavior(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
	acct := h.seedAccount(t, "gho_legacy", "ghr_legacy", time.Time{})

	token, err := h.svc.RefreshUserGitHubTokenIfExpiring(context.Background(), acct, "gho_legacy")
	require.NoError(t, err)
	assert.Equal(t, "gho_legacy", token, "a row with no persisted expiry must be left alone")
	assert.Zero(t, atomic.LoadInt64(h.refreshHits), "unknown expiry must never trigger a speculative refresh")
}

// TestGitHubRefresh_RevokedRefreshTokenSurfacesReconnect is the honest-failure
// requirement. When the grant is genuinely gone no retry can help, so the caller
// must get a machine-readable "reconnect GitHub" state — not an opaque 401 that
// a client will retry forever — and the dead refresh token must be cleared so the
// next request short-circuits instead of hammering GitHub.
func TestGitHubRefresh_RevokedRefreshTokenSurfacesReconnect(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, func(int64, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, fmt.Errorf("%w: bad_refresh_token", ErrGitHubRefreshTokenInvalid)
	})
	acct := h.seedAccount(t, "gho_stale", "ghr_revoked", h.now.Add(-time.Minute))

	_, err := h.svc.RefreshUserGitHubToken(context.Background(), acct)
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr), "must surface a structured API error")
	assert.Equal(t, http.StatusUnauthorized, apiErr.Status, "still a 401 so status-only clients are unaffected")
	assert.Equal(t, pkgerrors.CodeGitHubReconnectRequired, apiErr.Code,
		"clients must be able to branch on a reconnect code instead of substring-matching a message")

	assert.Empty(t, h.store.snapshot().RefreshTokenEncrypted,
		"a definitively dead refresh token must be cleared, not retried forever")
	assert.Equal(t, definitiveGitHubOAuth401Message, apiErr.Message, multiVerdictContract)
}

// definitiveGitHubOAuth401Message and multiVerdictContract pin a CROSS-REPO
// contract that is invisible from inside this repo.
//
// The multi worker decides whether a 401 means "reconnect GitHub" (scoped, keep
// the session) or "your session is dead" (GLOBAL SIGN-OUT) by exact-matching
// plue's 401 message against DEFINITIVE_GITHUB_OAUTH_MESSAGES in
// multi/src/smithersCloud/platformFetch.ts. Rewording plue's message — even to
// something friendlier and more honest-sounding — silently converts every
// expired-GitHub-grant 401 into a full sign-out, which is exactly the "I keep
// getting signed out" symptom this work exists to remove.
const (
	definitiveGitHubOAuth401Message = "github oauth token was rejected"
	multiVerdictContract            = "multi exact-matches this string to keep the 401 scoped; changing it signs users out of the whole app (see multi/src/smithersCloud/platformFetch.ts DEFINITIVE_GITHUB_OAUTH_MESSAGES)"
)

// TestGitHubRefresh_MissingRefreshTokenSurfacesReconnect covers the other
// unrecoverable shape: nothing was ever stored to refresh with.
func TestGitHubRefresh_MissingRefreshTokenSurfacesReconnect(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
	acct := h.seedAccount(t, "gho_stale", "ghr_stale", time.Time{})
	acct.RefreshTokenEncrypted = nil

	_, err := h.svc.RefreshUserGitHubToken(context.Background(), acct)
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, pkgerrors.CodeGitHubReconnectRequired, apiErr.Code)
	assert.Equal(t, definitiveGitHubOAuth401Message, apiErr.Message, multiVerdictContract)
	assert.Zero(t, atomic.LoadInt64(h.refreshHits), "nothing to refresh with means GitHub must not be called")
}

// TestGitHubRefresh_HealsRefreshClearedByConcurrentReplica is the cross-replica
// race this change fixes.
//
// The in-process per-user mutex only serializes goroutines inside ONE pod. With
// several API replicas, two pods can read the same row and both call GitHub with
// the same single-use refresh token. One wins; the loser gets bad_refresh_token
// and clears refresh_token_encrypted. If that clear lands BEFORE the winner's
// rotation, the winner's CAS (which matches on both ciphertexts) touches zero
// rows and its freshly minted, perfectly valid refresh token is thrown away —
// stranding the account in "reconnect GitHub" despite a healthy grant, and
// handing the current request the stale expired token.
//
// The winner holds the newest credential by construction, so it must re-assert.
func TestGitHubRefresh_HealsRefreshClearedByConcurrentReplica(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
	stale := h.seedAccount(t, "gho_stale", "ghr_stale", h.now.Add(-time.Minute))

	// Interleave the losing replica precisely: the row still looks untouched on
	// the pre-refresh re-read (read #1), and the loser's clear lands immediately
	// after — i.e. after we spent the refresh token but before our CAS.
	h.store.onRead = func(store *expiryStoreT, read int64) {
		if read != 1 {
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		store.account.RefreshTokenEncrypted = nil
	}

	token, err := h.svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.Equal(t, "gho_fresh_1", token,
		"the winner must return the token GitHub just minted, never the stale expired one")

	stored := h.store.snapshot()
	assert.Equal(t, "gho_fresh_1", h.decrypt(t, stored.AccessTokenEncrypted))
	require.NotEmpty(t, stored.RefreshTokenEncrypted,
		"the refresh chain must survive a concurrent replica clearing the column")
	assert.Equal(t, "ghr_fresh_1", h.decrypt(t, stored.RefreshTokenEncrypted),
		"the freshly rotated refresh token must be re-asserted over the concurrent clear")
	require.True(t, stored.ExpiresAt.Valid, "the healed row must also carry the new expiry")
}

// TestGitHubRefresh_ConcurrentProactiveRefreshSpendsRefreshTokenOnce asserts the
// single-use invariant holds for the PROACTIVE entry point too: many in-flight
// requests noticing the same expired token must collapse into one exchange.
func TestGitHubRefresh_ConcurrentProactiveRefreshSpendsRefreshTokenOnce(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, rotatingRefresh)
	expired := h.seedAccount(t, "gho_expired", "ghr_expired", h.now.Add(-time.Minute))

	const callers = 8
	var wg sync.WaitGroup
	tokens := make([]string, callers)
	errs := make([]error, callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			tokens[idx], errs[idx] = h.svc.RefreshUserGitHubTokenIfExpiring(context.Background(), expired, "gho_expired")
		}(i)
	}
	close(start)
	wg.Wait()

	for i := 0; i < callers; i++ {
		require.NoError(t, errs[i], "caller %d must not be signed out while a fresh token exists", i)
		assert.Equal(t, "gho_fresh_1", tokens[i], "caller %d must end on the winner's rotated token", i)
	}
	assert.Equal(t, int64(1), atomic.LoadInt64(h.refreshHits),
		"the single-use refresh token must be spent EXACTLY once (2+ exchanges kill the grant)")
}

// TestGitHubRefresh_ProactiveFailureInsideSkewKeepsWorkingToken guards against
// the fix causing the very outage it prevents. Inside the skew window the stored
// token has NOT actually expired, so a failed refresh (GitHub down, transient
// error) must fall back to the token that still works rather than signing the
// user out early.
func TestGitHubRefresh_ProactiveFailureInsideSkewKeepsWorkingToken(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, func(int64, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, errors.New("github oauth refresh request failed")
	})
	acct := h.seedAccount(t, "gho_still_valid", "ghr_current", h.now.Add(githubTokenRefreshSkew/2))

	token, err := h.svc.RefreshUserGitHubTokenIfExpiring(context.Background(), acct, "gho_still_valid")
	require.NoError(t, err, "a token that has not actually expired must not fail the request")
	assert.Equal(t, "gho_still_valid", token)
}

// TestGitHubRefresh_ProactiveFailureAfterExpiryIsHonest is the other half: once
// the token really is expired, a refresh failure must surface rather than hand
// back a credential we know GitHub will reject.
func TestGitHubRefresh_ProactiveFailureAfterExpiryIsHonest(t *testing.T) {
	t.Parallel()
	h := newExpiryHarness(t, db.OauthAccount{}, func(int64, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{}, fmt.Errorf("%w: bad_refresh_token", ErrGitHubRefreshTokenInvalid)
	})
	acct := h.seedAccount(t, "gho_expired", "ghr_revoked", h.now.Add(-time.Second))

	_, err := h.svc.RefreshUserGitHubTokenIfExpiring(context.Background(), acct, "gho_expired")
	require.Error(t, err, "an expired token that cannot be renewed must not be passed off as usable")

	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, pkgerrors.CodeGitHubReconnectRequired, apiErr.Code)
}

// TestGitHubTokenExpiry_NeverFabricatesADeadline pins the helper's contract.
func TestGitHubTokenExpiry_NeverFabricatesADeadline(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)

	assert.False(t, githubTokenExpiry(now, 0).Valid, "no expires_in means NULL, never a guess")
	assert.False(t, githubTokenExpiry(now, -1).Valid, "a nonsense expires_in means NULL, never a past deadline")

	got := githubTokenExpiry(now, int64(githubAccessTokenLifetime/time.Second))
	require.True(t, got.Valid)
	assert.Equal(t, now.Add(githubAccessTokenLifetime), got.Time.UTC())
}
