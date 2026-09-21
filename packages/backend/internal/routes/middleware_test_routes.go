package routes

import (
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SearchRateLimitResetter is the DB interface needed by ResetSearchRateLimits.
type SearchRateLimitResetter interface {
	DeleteExpiredSearchRateLimits(ctx context.Context, cutoffAt time.Time) error
	DeleteAllRateLimits(ctx context.Context) error
}

var middlewareTimeoutIgnoreContextSleep = time.Sleep

// MiddlewarePanic is a deterministic panic route for middleware E2E tests.
func MiddlewarePanic(w http.ResponseWriter, r *http.Request) {
	panic("middleware panic test route")
}

// MiddlewareTimeout waits for context cancellation to trigger timeout middleware behavior.
func MiddlewareTimeout(w http.ResponseWriter, r *http.Request) {
	<-r.Context().Done()
}

// MiddlewareTimeoutIgnoreContext sleeps without observing request context cancellation.
func MiddlewareTimeoutIgnoreContext(w http.ResponseWriter, r *http.Request) {
	middlewareTimeoutIgnoreContextSleep(5 * time.Second)
}

// ResetSearchRateLimits deletes all search rate limit records (for E2E test isolation).
// Only registered when SMITHERS_ENABLE_E2E_TEST_ROUTES=true.
func ResetSearchRateLimits(queries SearchRateLimitResetter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Use a far-future cutoff to delete all records regardless of age.
		if err := queries.DeleteExpiredSearchRateLimits(r.Context(), time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)); err != nil {
			pkgerrors.WriteError(w, pkgerrors.Internal("failed to reset rate limits"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ResetAuthRateLimits deletes all auth rate limit records (for E2E test isolation).
// Only registered when SMITHERS_ENABLE_E2E_TEST_ROUTES=true.
func ResetAuthRateLimits(queries SearchRateLimitResetter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := queries.DeleteAllRateLimits(r.Context()); err != nil {
			pkgerrors.WriteError(w, pkgerrors.Internal("failed to reset auth rate limits"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
