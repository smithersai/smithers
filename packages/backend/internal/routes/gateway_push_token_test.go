package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type gatewayPushMintFunc func(context.Context, string, string, services.GatewayPushTokenInput) (services.GatewayPushTokenResult, error)

func (f gatewayPushMintFunc) Mint(ctx context.Context, id, token string, input services.GatewayPushTokenInput) (services.GatewayPushTokenResult, error) {
	return f(ctx, id, token, input)
}

func TestGatewayPushTokenHandler_Contract(t *testing.T) {
	calls := 0
	var mintErr error
	expires := time.Now().UTC().Add(5 * time.Minute)
	h := &RepoGatewayHandler{PushTokens: gatewayPushMintFunc(func(_ context.Context, id, token string, input services.GatewayPushTokenInput) (services.GatewayPushTokenResult, error) {
		calls++
		require.Equal(t, "gateway", id)
		require.Equal(t, "operator", token)
		require.Equal(t, "alice/demo", input.Repo)
		return services.GatewayPushTokenResult{Token: "secret", TokenID: 7, RepositoryID: 42, Scopes: "write:repository,repo:42", ExpiresAt: expires}, mintErr
	})}
	router := chi.NewRouter()
	router.Post("/api/gateways/{gatewayID}/push-token", h.MintPushToken)
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/gateways/gateway/push-token", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer operator")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		return w
	}
	valid := `{"repo":"alice/demo"}`
	w := request(valid)
	require.Equal(t, 201, w.Code)
	var result services.GatewayPushTokenResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.Equal(t, "secret", result.Token)
	require.Equal(t, int64(7), result.TokenID)
	require.Equal(t, int64(42), result.RepositoryID)
	require.Equal(t, "write:repository,repo:42", result.Scopes)
	require.Equal(t, expires, result.ExpiresAt)
	for _, bad := range []string{valid + " {}", "{", `{"repo":"alice/demo","scopes":"all"}`, `{"repo":"` + strings.Repeat("a", 4096) + `"}`} {
		require.Equal(t, 400, request(bad).Code)
	}
	require.Equal(t, 1, calls)
	for _, refusal := range []*pkgerrors.APIError{
		pkgerrors.Unauthorized("invalid gateway credentials"),
		pkgerrors.Forbidden("repository write permission required"),
		pkgerrors.Conflict("repo gateway is not running"),
		pkgerrors.New(pkgerrors.CodeRateLimitExceeded, "mint limit exceeded"),
		pkgerrors.New(pkgerrors.CodeRateLimiterUnavailable, "limiter unavailable"),
	} {
		mintErr = refusal
		if refusal.Status == 429 {
			refusal.RetryAfter = 20
		}
		w = request(valid)
		require.Equal(t, refusal.Status, w.Code)
		require.Contains(t, w.Body.String(), string(refusal.Code))
		require.NotContains(t, w.Body.String(), "secret")
		if refusal.Status == 429 {
			require.Equal(t, "20", w.Header().Get("Retry-After"))
		}
	}
}
