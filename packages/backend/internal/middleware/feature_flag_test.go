package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nextOK is a tiny terminal handler that records whether it was reached and
// always responds 200. Tests use this to distinguish a passed gate (handler
// reached, status 200) from a blocked gate (handler not reached, status 403).
type nextOK struct {
	called atomic.Bool
}

func (h *nextOK) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	h.called.Store(true)
	w.WriteHeader(http.StatusOK)
}

// TestFeatureFlagGate_Allows asserts the gate forwards to next when the
// predicate returns true.
func TestFeatureFlagGate_Allows(t *testing.T) {
	t.Parallel()

	h := &nextOK{}
	gate := FeatureFlagGate(func() bool { return true })
	wrapped := gate(h)

	req := httptest.NewRequest(http.MethodGet, "/api/issues", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	assert.True(t, h.called.Load(), "next handler should have been called")
	assert.Equal(t, http.StatusOK, rec.Code)
}

// TestFeatureFlagGate_Denies asserts the gate returns 403 with the exact
// Gitea-compatible APIError JSON ({"message":"feature not available"})
// required by ticket 12.
func TestFeatureFlagGate_Denies(t *testing.T) {
	t.Parallel()

	h := &nextOK{}
	gate := FeatureFlagGate(func() bool { return false })
	wrapped := gate(h)

	req := httptest.NewRequest(http.MethodGet, "/api/issues", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	assert.False(t, h.called.Load(), "next handler should NOT have been called")
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, featureNotAvailableMessage, body["message"], "body must carry the contract message")
	assert.Equal(t, "feature not available", body["message"], "ticket 12 spec body")
}

// TestFeatureFlagGate_NilPredicate asserts the fail-closed behavior — a nil
// predicate returns 403 and never reaches the handler. This catches wiring
// bugs where someone mounts the gate without supplying a flag accessor.
func TestFeatureFlagGate_NilPredicate(t *testing.T) {
	t.Parallel()

	h := &nextOK{}
	gate := FeatureFlagGate(nil)
	wrapped := gate(h)

	req := httptest.NewRequest(http.MethodGet, "/api/whatever", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	assert.False(t, h.called.Load(), "nil predicate should fail closed")
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

// TestFeatureFlagGate_DynamicFlip asserts that flipping the flag between
// requests is picked up immediately (no caching layer). The first request
// passes through; we flip the flag; the second request is denied.
func TestFeatureFlagGate_DynamicFlip(t *testing.T) {
	t.Parallel()

	enabled := true
	gate := FeatureFlagGate(func() bool { return enabled })

	// First request — flag on.
	{
		h := &nextOK{}
		wrapped := gate(h)
		req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
		rec := httptest.NewRecorder()
		wrapped.ServeHTTP(rec, req)
		assert.True(t, h.called.Load())
		assert.Equal(t, http.StatusOK, rec.Code)
	}

	// Flip the flag.
	enabled = false

	// Second request — flag off.
	{
		h := &nextOK{}
		wrapped := gate(h)
		req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
		rec := httptest.NewRecorder()
		wrapped.ServeHTTP(rec, req)
		assert.False(t, h.called.Load())
		assert.Equal(t, http.StatusForbidden, rec.Code)
	}
}
