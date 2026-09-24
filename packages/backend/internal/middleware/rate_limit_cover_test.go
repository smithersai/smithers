package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type rateLimitCovStaticStore struct {
	mu           sync.Mutex
	rows         []db.ConsumeSearchRateLimitTokenRow
	consumeCalls int
	cleanupCalls int
}

func (s *rateLimitCovStaticStore) ConsumeSearchRateLimitToken(context.Context, db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.consumeCalls++
	if len(s.rows) == 0 {
		return db.ConsumeSearchRateLimitTokenRow{Allowed: true, RemainingTokens: 1}, nil
	}
	row := s.rows[0]
	s.rows = s.rows[1:]
	return row, nil
}

func (s *rateLimitCovStaticStore) DeleteExpiredSearchRateLimits(context.Context, time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupCalls++
	return nil
}

func TestRateLimit_Cov_MiddlewareClampsRemainingAndNegativeReset(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)

	store := &rateLimitCovStaticStore{
		rows: []db.ConsumeSearchRateLimitTokenRow{{
			Allowed:         true,
			RemainingTokens: -0.25,
		}},
	}
	limiter := &rateLimiter{
		store:           store,
		scope:           "cover",
		limit:           10,
		window:          time.Minute,
		refillPerSecond: 10.0 / 60.0,
		nowFn:           func() time.Time { return now },
	}
	handler := limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/cover", nil)
	req.RemoteAddr = "192.0.2.10:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "0", rec.Header().Get("X-RateLimit-Remaining"))

	store = &rateLimitCovStaticStore{
		rows: []db.ConsumeSearchRateLimitTokenRow{{
			Allowed:         true,
			RemainingTokens: 0.5,
		}},
	}
	limiter = &rateLimiter{
		store:           store,
		scope:           "cover",
		limit:           10,
		window:          time.Minute,
		refillPerSecond: -1,
		nowFn:           func() time.Time { return now },
	}
	handler = limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "0", rec.Header().Get("X-RateLimit-Remaining"))
	assert.Equal(t, strconv.FormatInt(now.Unix(), 10), rec.Header().Get("X-RateLimit-Reset"))
}

func TestRateLimit_Cov_RetryAfterNonFutureReset(t *testing.T) {
	t.Parallel()

	limiter := &rateLimiter{}
	now := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)

	assert.Equal(t, 0, limiter.retryAfterSeconds(now, now))
	assert.Equal(t, 0, limiter.retryAfterSeconds(now, now.Add(-time.Second)))
	assert.Equal(t, 2, limiter.retryAfterSeconds(now, now.Add(1500*time.Millisecond)))
}

func TestRateLimit_Cov_DefaultConstructors(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	emailHandler := EmailVerificationRateLimit(nil)(next)
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
	rec := httptest.NewRecorder()
	emailHandler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))

	telemetryHandler := TelemetryRateLimit(nil)(next)
	req = httptest.NewRequest(http.MethodPost, "/api/telemetry", nil)
	rec = httptest.NewRecorder()
	telemetryHandler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "10", rec.Header().Get("X-RateLimit-Limit"))

	globalHandler := NewGlobalAPIRateLimit(nil, 0, 0, 0)(next)
	req = httptest.NewRequest(http.MethodGet, "/api/repos", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 42, Username: "alice"},
	}))
	rec = httptest.NewRecorder()
	globalHandler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "5000", rec.Header().Get("X-RateLimit-Limit"))

	req = httptest.NewRequest(http.MethodGet, "/api/repos", nil)
	rec = httptest.NewRecorder()
	globalHandler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "600", rec.Header().Get("X-RateLimit-Limit"))
}

func TestRateLimit_Cov_MatchesExcludedPathEdges(t *testing.T) {
	t.Parallel()

	assert.False(t, matchesExcludedPath("/api/search", "   "))
	assert.True(t, matchesExcludedPath("/api/search", "/api/search"))
	assert.False(t, matchesExcludedPath("/api/search/repositories", "/api/search"))
}
