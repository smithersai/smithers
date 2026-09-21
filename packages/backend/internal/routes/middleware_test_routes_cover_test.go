package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type middlewareTestRoutesCovResetter struct {
	deleteExpiredFn func(context.Context, time.Time) error
	deleteAllFn     func(context.Context) error
}

func (r middlewareTestRoutesCovResetter) DeleteExpiredSearchRateLimits(ctx context.Context, cutoffAt time.Time) error {
	return r.deleteExpiredFn(ctx, cutoffAt)
}

func (r middlewareTestRoutesCovResetter) DeleteAllRateLimits(ctx context.Context) error {
	return r.deleteAllFn(ctx)
}

func TestMiddlewareTestRoutes_Cov_ResetSearchAndAuthRateLimits(t *testing.T) {
	t.Parallel()

	t.Run("search success uses far future cutoff", func(t *testing.T) {
		t.Parallel()

		var gotCutoff time.Time
		handler := ResetSearchRateLimits(middlewareTestRoutesCovResetter{
			deleteExpiredFn: func(_ context.Context, cutoffAt time.Time) error {
				gotCutoff = cutoffAt
				return nil
			},
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/reset-search", nil))

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, 9999, gotCutoff.Year())
	})

	t.Run("search error", func(t *testing.T) {
		t.Parallel()

		handler := ResetSearchRateLimits(middlewareTestRoutesCovResetter{
			deleteExpiredFn: func(context.Context, time.Time) error { return errors.New("db down") },
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/reset-search", nil))

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "failed to reset rate limits")
	})

	t.Run("auth success and error", func(t *testing.T) {
		t.Parallel()

		var called bool
		okHandler := ResetAuthRateLimits(middlewareTestRoutesCovResetter{
			deleteAllFn: func(context.Context) error {
				called = true
				return nil
			},
		})
		okRec := httptest.NewRecorder()
		okHandler.ServeHTTP(okRec, httptest.NewRequest(http.MethodPost, "/reset-auth", nil))
		require.Equal(t, http.StatusNoContent, okRec.Code)
		assert.True(t, called)

		errHandler := ResetAuthRateLimits(middlewareTestRoutesCovResetter{
			deleteAllFn: func(context.Context) error { return errors.New("db down") },
		})
		errRec := httptest.NewRecorder()
		errHandler.ServeHTTP(errRec, httptest.NewRequest(http.MethodPost, "/reset-auth", nil))
		require.Equal(t, http.StatusInternalServerError, errRec.Code)
		assert.Contains(t, errRec.Body.String(), "failed to reset auth rate limits")
	})
}

func TestMiddlewareTestRoutes_Cov_TimeoutObservesContextCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	req := httptest.NewRequest(http.MethodGet, "/timeout", nil).WithContext(ctx)

	go func() {
		MiddlewareTimeout(httptest.NewRecorder(), req)
		close(done)
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("MiddlewareTimeout did not return after context cancellation")
	}
}
