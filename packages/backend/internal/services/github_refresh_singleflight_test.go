package services

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// refreshStoreT is a tiny thread-safe stand-in for the oauth_accounts row that
// AuthService.RefreshUserGitHubToken reads and rotates. It models the ONE thing
// that makes concurrent GitHub App refreshes dangerous: the stored access/refresh
// ciphertext pair is single-use, and only a compare-and-swap keyed on the stale
// ciphertext may rotate it. GetOAuthAccountByProviderUserID returns the current
// snapshot; RotateOAuthAccountTokensCAS performs a real CAS.
type refreshStoreT struct {
	mu      sync.Mutex
	account db.OauthAccount
}

func (r *refreshStoreT) get() db.OauthAccount {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.account
}

// cas rotates the stored pair only when the stored access ciphertext still equals
// the caller's stale one (mirrors the WHERE old_access = $stored SQL predicate).
func (r *refreshStoreT) cas(newAccess, newRefresh, oldAccess []byte) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if string(r.account.AccessTokenEncrypted) != string(oldAccess) {
		return 0
	}
	r.account.AccessTokenEncrypted = newAccess
	r.account.RefreshTokenEncrypted = newRefresh
	return 1
}

// newSingleFlightRefresherHarness wires a real *AuthService (the production
// refresher that BOTH GitHubImportService and GitHubUserReposService delegate to
// — see cmd/server/main.go) over a stateful account store and a GitHub client
// whose RefreshToken call is the "GitHub refresh endpoint" — every hit is counted
// so the tests can assert the single-use refresh token is spent at most once.
func newSingleFlightRefresherHarness(t *testing.T, store *refreshStoreT, refreshHits *int64) *AuthService {
	t.Helper()
	cfg := defaultAuthConfig()

	client := mockGitHubClient{
		refreshTokenFn: func(ctx context.Context, refreshToken string) (GitHubTokenResult, error) {
			// A real refresh consumes the single-use refresh token and rotates the
			// pair. Count every reach-out to GitHub.
			n := atomic.AddInt64(refreshHits, 1)
			_ = n
			return GitHubTokenResult{AccessToken: "gho_new_access", RefreshToken: "ghr_new_refresh"}, nil
		},
	}

	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return store.get(), nil
		},
		rotateOAuthAccountTokensCASFn: func(_ context.Context, arg db.RotateOAuthAccountTokensCASParams) (int64, error) {
			return store.cas(arg.AccessTokenEncrypted, arg.RefreshTokenEncrypted, arg.OldAccessTokenEncrypted), nil
		},
	}
	return NewAuthService(querier, cfg, nil, client)
}

// TestGitHubTokenRefresh_SingleFlight_ConcurrentRefreshHitsGitHubOnce is the
// primary RED test for the session-instability bug: when several in-flight
// GitHub-backed requests each 401 on the same expired access token and each calls
// the shared refresher CONCURRENTLY, the single-use refresh token must be spent
// EXACTLY ONCE. A second concurrent refresh would replay the just-consumed refresh
// token, which GitHub invalidates the whole grant for — bricking the session until
// re-login. Both callers must end with the winner's rotated access token.
func TestGitHubTokenRefresh_SingleFlight_ConcurrentRefreshHitsGitHubOnce(t *testing.T) {
	cfg := defaultAuthConfig()
	stale := db.OauthAccount{
		UserID:                42,
		Provider:              "github",
		ProviderUserID:        "gh-42",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_stale_access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_stale_refresh"),
	}
	store := &refreshStoreT{account: stale}
	var refreshHits int64
	svc := newSingleFlightRefresherHarness(t, store, &refreshHits)

	const callers = 8
	var wg sync.WaitGroup
	tokens := make([]string, callers)
	errs := make([]error, callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start // release all goroutines together to maximize the race
			// Every caller 401'd on the SAME stale account it read moments ago.
			tokens[idx], errs[idx] = svc.RefreshUserGitHubToken(context.Background(), stale)
		}(i)
	}
	close(start)
	wg.Wait()

	for i := 0; i < callers; i++ {
		require.NoError(t, errs[i], "caller %d must not surface 'token was rejected' when a fresh token exists", i)
		assert.Equal(t, "gho_new_access", tokens[i], "caller %d must end with the winner's rotated token", i)
	}
	assert.Equal(t, int64(1), atomic.LoadInt64(&refreshHits),
		"the single-use GitHub refresh token must be spent EXACTLY once across concurrent refreshes (2+ hits = the grant-killing race)")
}

// TestGitHubTokenRefresh_SingleFlight_AlreadyRotatedSkipsGitHub covers the
// re-read-before-refresh contract: if a winner rotated the stored pair while this
// caller was blocked (or between its 401 and its refresh), the caller must return
// the fresh STORED token without reaching out to GitHub at all.
func TestGitHubTokenRefresh_SingleFlight_AlreadyRotatedSkipsGitHub(t *testing.T) {
	cfg := defaultAuthConfig()
	stale := db.OauthAccount{
		UserID:                7,
		Provider:              "github",
		ProviderUserID:        "gh-7",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_stale_access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_stale_refresh"),
	}
	// The store already holds a rotated pair (a winner beat us).
	rotated := stale
	rotated.AccessTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "gho_new_access")
	rotated.RefreshTokenEncrypted = authHEncrypt(t, cfg.SessionSecret, "ghr_new_refresh")
	store := &refreshStoreT{account: rotated}
	var refreshHits int64
	svc := newSingleFlightRefresherHarness(t, store, &refreshHits)

	token, err := svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.Equal(t, "gho_new_access", token, "must serve the freshly stored token")
	assert.Equal(t, int64(0), atomic.LoadInt64(&refreshHits),
		"a caller that finds the stored token already rotated must NOT hit GitHub")
}

// TestGitHubTokenRefresh_SingleFlight_CASLoserDoesNotClobber covers the multi-pod
// backstop: an in-process lock cannot serialize across the 2 prod api pods, so a
// stale refresh writer may still reach the persist step after another pod already
// rotated the pair. The compare-and-swap (WHERE stored access = the stale one we
// read) must lose (0 rows) and the caller must return the newer STORED token
// rather than overwriting it with its own now-stale rotation.
func TestGitHubTokenRefresh_SingleFlight_CASLoserDoesNotClobber(t *testing.T) {
	cfg := defaultAuthConfig()
	stale := db.OauthAccount{
		UserID:                9,
		Provider:              "github",
		ProviderUserID:        "gh-9",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_stale_access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_stale_refresh"),
	}
	// Store still shows the stale pair at re-read time (so this caller proceeds to
	// refresh), but the CAS write loses because another pod rotated concurrently.
	store := &refreshStoreT{account: stale}
	winnerAccess := authHEncrypt(t, cfg.SessionSecret, "gho_winner_access")
	winnerRefresh := authHEncrypt(t, cfg.SessionSecret, "ghr_winner_refresh")

	var refreshHits int64
	client := mockGitHubClient{
		refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
			atomic.AddInt64(&refreshHits, 1)
			return GitHubTokenResult{AccessToken: "gho_loser_access", RefreshToken: "ghr_loser_refresh"}, nil
		},
	}
	querier := &mockAuthQuerier{
		getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
			return store.get(), nil
		},
		rotateOAuthAccountTokensCASFn: func(context.Context, db.RotateOAuthAccountTokensCASParams) (int64, error) {
			// Simulate the other pod winning the CAS: advance the store to the
			// winner's pair and report 0 rows updated for this stale writer.
			store.mu.Lock()
			store.account.AccessTokenEncrypted = winnerAccess
			store.account.RefreshTokenEncrypted = winnerRefresh
			store.mu.Unlock()
			return 0, nil
		},
	}
	svc := NewAuthService(querier, cfg, nil, client)

	token, err := svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.Equal(t, "gho_winner_access", token,
		"a CAS loser must return the newer stored pair, never clobber with its own rotation")
	// The stored pair must remain the winner's, untouched by the loser.
	assert.Equal(t, string(winnerAccess), string(store.get().AccessTokenEncrypted),
		"the stored access ciphertext must stay the winner's")
}

// TestGitHubTokenRefresh_SingleFlight_SequentialExpiryRefreshesAgain proves the
// single-flight guard does not wedge the account: a LATER, distinct expiry (after
// the first refresh committed) must be allowed to refresh again.
func TestGitHubTokenRefresh_SingleFlight_SequentialExpiryRefreshesAgain(t *testing.T) {
	cfg := defaultAuthConfig()
	stale := db.OauthAccount{
		UserID:                11,
		Provider:              "github",
		ProviderUserID:        "gh-11",
		AccessTokenEncrypted:  authHEncrypt(t, cfg.SessionSecret, "gho_stale_access"),
		RefreshTokenEncrypted: authHEncrypt(t, cfg.SessionSecret, "ghr_stale_refresh"),
	}
	store := &refreshStoreT{account: stale}
	var refreshHits int64
	svc := newSingleFlightRefresherHarness(t, store, &refreshHits)

	token, err := svc.RefreshUserGitHubToken(context.Background(), stale)
	require.NoError(t, err)
	assert.Equal(t, "gho_new_access", token)
	require.Equal(t, int64(1), atomic.LoadInt64(&refreshHits))

	// Hours later the (now rotated & stored) token expires again. Read it fresh,
	// then refresh: this is a genuinely new expiry, so GitHub is hit a 2nd time.
	nowStored := store.get()
	token, err = svc.RefreshUserGitHubToken(context.Background(), nowStored)
	require.NoError(t, err)
	assert.Equal(t, "gho_new_access", token)
	assert.Equal(t, int64(2), atomic.LoadInt64(&refreshHits),
		"a later distinct expiry must be allowed to refresh again")
}
