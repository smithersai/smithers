package middleware

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRateLimitQuotas_Cov_TokenBucketStoreEdges(t *testing.T) {
	t.Parallel()

	now := realClock{}.Now()
	assert.Equal(t, time.UTC, now.Location())

	require.NotNil(t, NewTokenBucketStore())

	nilClockStore := NewTokenBucketStoreWithClock(nil)
	allowed, retryAfter := nilClockStore.TakeN(context.Background(), "disabled", 1, 0, time.Hour)
	assert.True(t, allowed)
	assert.Equal(t, time.Duration(0), retryAfter)

	clock := NewFakeClock(time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)
	allowed, retryAfter = store.TakeN(context.Background(), "n-defaults-to-one", 0, 1, time.Hour)
	require.True(t, allowed)
	assert.Equal(t, time.Duration(0), retryAfter)

	allowed, retryAfter = store.TakeN(context.Background(), "n-defaults-to-one", 1, 1, time.Hour)
	assert.False(t, allowed)
	assert.Greater(t, retryAfter, time.Duration(0))

	allowed, retryAfter = store.TakeN(context.Background(), "non-finite-charge", math.Inf(1), 10, time.Hour)
	assert.False(t, allowed)
	assert.Equal(t, time.Hour, retryAfter)
}

func TestRateLimitQuotas_Cov_RateLimitExceededMinimumRetryAfter(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	rateLimitExceededResponse(rec, 0)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "rate limit exceeded", body["message"])
	// retry_after, not retry_after_seconds: this middleware now answers with
	// the one envelope, whose wait key every other paced failure already uses.
	assert.Equal(t, float64(1), body["retry_after"])
	assert.NotContains(t, body, "retry_after_seconds")
	assert.Equal(t, "rate_limit_exceeded", body["code"])
	assert.Equal(t, "user", body["fault"])
}

func TestRateLimitQuotas_Cov_RepoBucketKeyFallsBackToRepoContext(t *testing.T) {
	t.Parallel()

	repo := &db.Repository{ID: 9, Name: "Widgets", LowerName: "Widgets"}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/Acme/Widgets", nil)
	ctx := ContextWithRepoContext(req.Context(), &RepoContext{Owner: "Acme", Repository: repo}, PermissionRead)

	key := repoBucketKey(req.WithContext(ctx), "scope")

	assert.Equal(t, "scope|repo:acme/widgets", key)
}

func TestRateLimitQuotas_Cov_PerRepoNilStorePassesThrough(t *testing.T) {
	t.Parallel()

	called := false
	handler := perRepoBucketMiddleware(nil, "scope", 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repos/acme/widgets", nil))

	assert.True(t, called)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestRateLimitQuotas_Cov_PerUserDefaultsAndNilCounters(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	run := func(t *testing.T, mw func(http.Handler) http.Handler) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/quotas", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: 42, Username: "alice"},
		}))
		rec := httptest.NewRecorder()
		mw(next).ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	run(t, PerUserConnectedRepos(nil, 0))
	run(t, PerUserConcurrentWorkflowRuns(nil, 2))
	run(t, PerUserConcurrentSandboxes(nil, 0))
}
