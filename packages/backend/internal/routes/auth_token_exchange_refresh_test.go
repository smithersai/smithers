package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// newRefreshTokenExchangeHandler mirrors newTokenExchangeHandler but over an
// exchange func that also receives the incoming GitHub refresh token, so the
// route test can assert the new github_refresh_token field is forwarded to the
// service unchanged.
func newRefreshTokenExchangeHandler(exchangeFn func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error)) http.Handler {
	handler := &AuthHandler{
		Service:    mockAuthService{exchangeGitHubFn: exchangeFn},
		AuthConfig: defaultRouteAuthConfig(),
	}
	return middleware.RequireSharedBearerToken("worker-secret")(http.HandlerFunc(handler.PostGitHubTokenExchange))
}

// TestAuthHandler_PostGitHubTokenExchange_ForwardsRefreshToken proves the plue
// side of the contract: a worker that posts github_refresh_token must have it
// forwarded to ExchangeGitHubToken. Fails today: postGitHubTokenExchangeRequest
// has no github_refresh_token field and PostGitHubTokenExchange never forwards
// one.
func TestAuthHandler_PostGitHubTokenExchange_ForwardsRefreshToken(t *testing.T) {
	t.Parallel()

	var gotRefresh string
	h := newRefreshTokenExchangeHandler(func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
		gotRefresh = githubRefreshToken
		return services.ExchangeGitHubTokenResult{User: db.User{ID: 42, Username: "octo"}, Token: "smithers_abc123", TokenID: 7}, nil
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_real","token_name":"multi-worker","github_refresh_token":" ghr_from_login "}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ghr_from_login", gotRefresh, "github_refresh_token must be trimmed and forwarded to the service")
}

// TestAuthHandler_PostGitHubTokenExchange_AbsentRefreshTokenForwardsEmpty is the
// regression guard: when github_refresh_token is absent, the service must be
// called with an empty refresh token — preserving today's behavior exactly.
func TestAuthHandler_PostGitHubTokenExchange_AbsentRefreshTokenForwardsEmpty(t *testing.T) {
	t.Parallel()

	gotRefresh := "sentinel"
	h := newRefreshTokenExchangeHandler(func(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
		gotRefresh = githubRefreshToken
		return services.ExchangeGitHubTokenResult{User: db.User{ID: 42, Username: "octo"}, Token: "smithers_abc123", TokenID: 7}, nil
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", strings.NewReader(`{"github_access_token":"gho_real","token_name":"multi-worker"}`))
	req.Header.Set("Authorization", "Bearer worker-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "", gotRefresh, "an absent github_refresh_token must forward an empty refresh token, exactly like today")
}
