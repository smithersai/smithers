package middleware

import (
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSharedBearerAwareTelemetryRateLimit_UntrustedAndIsolated(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, expected, header string }{
		{"unset", "", "Bearer any"}, {"missing", "shared", ""}, {"wrong", "shared", "Bearer wrong"}, {"malformed", "shared", "Basic shared"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockRateLimitStore{}
			handler := SharedBearerAwareTelemetryRateLimit(store, tc.expected)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
			for i := 0; i < 11; i++ {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.201:9999", tc.header))
				if i < 10 {
					require.Equal(t, http.StatusNoContent, rec.Code)
				} else {
					require.Equal(t, http.StatusTooManyRequests, rec.Code)
				}
			}
			assert.NotContains(t, store.keysSeen, "telemetry_worker|ip:203.0.113.201")
		})
	}
	store := &mockRateLimitStore{}
	handler := SharedBearerAwareTelemetryRateLimit(store, "shared")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.202:9999", "Bearer shared"))
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Contains(t, store.keysSeen, "telemetry_worker|ip:203.0.113.202")
	require.NotContains(t, store.keysSeen, "auth_worker|ip:203.0.113.202")
	require.NotContains(t, store.keysSeen, "telemetry|ip:203.0.113.202")
}

func TestSharedBearerAwareTelemetryRateLimit_WorkerLimitAndLoginIsolation(t *testing.T) {
	t.Parallel()
	store := &mockRateLimitStore{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := SharedBearerAwareTelemetryRateLimit(store, "shared")(next)
	post := func(bearer string) int {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.203:9999", bearer))
		return rec.Code
	}
	for i := 0; i < 10; i++ {
		require.Equal(t, http.StatusNoContent, post(""))
	}
	require.Equal(t, http.StatusTooManyRequests, post(""))
	for i := 0; i < 120; i++ {
		require.Equal(t, http.StatusNoContent, post("Bearer shared"), "worker report %d", i)
	}
	require.Equal(t, http.StatusTooManyRequests, post("Bearer shared"))
	rec := httptest.NewRecorder()
	SharedBearerAwareAuthRateLimit(store, "shared", 120, time.Minute)(next).ServeHTTP(rec, sharedBearerAuthReq("203.0.113.203:9999", "Bearer shared"))
	require.Equal(t, http.StatusNoContent, rec.Code, "telemetry must not drain login capacity")
}
