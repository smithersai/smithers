package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func newTokenExchangeHandler(exchangeFn func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error)) http.Handler {
	handler := &AuthHandler{
		Service:    mockAuthService{exchangeGitHubFn: exchangeFn},
		AuthConfig: defaultRouteAuthConfig(),
	}
	return middleware.RequireSharedBearerToken("worker-secret")(http.HandlerFunc(handler.PostGitHubTokenExchange))
}

func TestAuthHandler_PostGitHubTokenExchange_Unauthorized(t *testing.T) {
	t.Parallel()

	h := newTokenExchangeHandler(nil)

	// Missing bearer.
	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_x"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	// Wrong bearer.
	req = httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_x"}`))
	req.Header.Set("Authorization", "Bearer wrong-secret")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAuthHandler_PostGitHubTokenExchange_MissingToken(t *testing.T) {
	t.Parallel()

	h := newTokenExchangeHandler(nil)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"token_name":"multi-worker"}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAuthHandler_PostGitHubTokenExchange_HappyPath(t *testing.T) {
	t.Parallel()

	var gotToken, gotName string
	var gotTTL *int64
	h := newTokenExchangeHandler(func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
		gotToken = githubAccessToken
		gotName = tokenName
		gotTTL = ttlSeconds
		return services.ExchangeGitHubTokenResult{
			User:    db.User{ID: 42, Username: "octo"},
			Token:   "smithers_abc123",
			TokenID: 7,
		}, nil
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_real","token_name":" multi-worker "}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "gho_real", gotToken)
	assert.Equal(t, "multi-worker", gotName)
	assert.Nil(t, gotTTL, "absent ttl_seconds must be passed through as nil")

	var body struct {
		Token     string `json:"token"`
		TokenID   int64  `json:"token_id"`
		ExpiresAt string `json:"expires_at"`
		User      struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
		} `json:"user"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "smithers_abc123", body.Token)
	assert.Equal(t, int64(7), body.TokenID)
	assert.Equal(t, int64(42), body.User.ID)
	assert.Equal(t, "octo", body.User.Username)
	assert.Empty(t, body.ExpiresAt, "expires_at is omitted when the service reports none")
}

func TestAuthHandler_PostGitHubTokenExchange_TTLAndExpiry(t *testing.T) {
	t.Parallel()

	expires := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	var gotTTL *int64
	h := newTokenExchangeHandler(func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
		gotTTL = ttlSeconds
		return services.ExchangeGitHubTokenResult{
			User:      db.User{ID: 42, Username: "octo"},
			Token:     "smithers_abc123",
			TokenID:   7,
			ExpiresAt: &expires,
		}, nil
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_real","token_name":"multi-worker-session-1","ttl_seconds":3600}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, gotTTL)
	assert.Equal(t, int64(3600), *gotTTL)

	var body struct {
		ExpiresAt string `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "2026-07-12T12:00:00Z", body.ExpiresAt)
}

type mockRepoListingWarmer struct {
	warmed []int64
}

func (m *mockRepoListingWarmer) WarmGitHubRepoListing(userID int64) {
	m.warmed = append(m.warmed, userID)
}

func TestAuthHandler_PostGitHubTokenExchange_WarmsRepoListingCache(t *testing.T) {
	t.Parallel()

	warmer := &mockRepoListingWarmer{}
	handler := &AuthHandler{
		Service: mockAuthService{exchangeGitHubFn: func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
			return services.ExchangeGitHubTokenResult{
				User:    db.User{ID: 42, Username: "octo"},
				Token:   "smithers_abc123",
				TokenID: 7,
			}, nil
		}},
		AuthConfig:        defaultRouteAuthConfig(),
		RepoListingWarmer: warmer,
	}
	h := middleware.RequireSharedBearerToken("worker-secret")(http.HandlerFunc(handler.PostGitHubTokenExchange))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_real"}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, []int64{42}, warmer.warmed, "successful exchange must warm the user's repo listing cache")
}

func TestAuthHandler_PostGitHubTokenExchange_NoWarmOnFailure(t *testing.T) {
	t.Parallel()

	warmer := &mockRepoListingWarmer{}
	handler := &AuthHandler{
		Service: mockAuthService{exchangeGitHubFn: func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
			return services.ExchangeGitHubTokenResult{}, errors.Unauthorized("github token rejected")
		}},
		AuthConfig:        defaultRouteAuthConfig(),
		RepoListingWarmer: warmer,
	}
	h := middleware.RequireSharedBearerToken("worker-secret")(http.HandlerFunc(handler.PostGitHubTokenExchange))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_bad"}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Empty(t, warmer.warmed, "failed exchange must not warm the cache")
}
