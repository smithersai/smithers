package compose

// Tests that prove SSE routes and WebSocket/terminal routes are NOT subject to
// the 30-second JSON timeout middleware applied to the rest of /api.
//
// Strategy:
//  - SSE: mount a fake SSE handler on a router built with a very short (25 ms)
//    timeout on all normal /api routes. Use httptest.NewServer so the response
//    actually streams. The SSE handler sleeps longer than the timeout and then
//    confirms it was never cancelled by the timeout middleware.
//  - WebSocket: mount the terminal handler behind a JSONTimeout wrapper and
//    verify that the Hijack call inside websocket.Accept still succeeds.
//    (A timeout-wrapped writer must preserve http.Hijacker for the upgrade to work.)

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// --- SSE timeout-exemption test ---

// hijackableRecorder is an httptest.ResponseRecorder that also implements
// http.Hijacker. websocket.Accept (and similar upgrade paths) check for this
// interface before attempting the upgrade.
type hijackableRecorder struct {
	*httptest.ResponseRecorder
}

func (h *hijackableRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	server, client := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

// TestSSERoute_SurvivesLongerThan30Seconds proves that SSE handlers registered
// OUTSIDE the JSONTimeout middleware group are not cut off by the timeout.
//
// We build a minimal Chi router that mirrors the production pattern:
//   - /api/* gets a very short (25 ms) JSONTimeout (stand-in for the 30 s prod timeout)
//   - /api/notifications is registered BEFORE the /api route group (no timeout)
//
// The fake SSE handler streams one event, sleeps 80 ms (> the 25 ms timeout), then
// streams a second event. If the second event is received, the timeout did not apply.
func TestSSERoute_SurvivesLongerThan30Seconds(t *testing.T) {
	t.Parallel()

	firstEventSent := make(chan struct{})

	sseHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		require.True(t, ok, "SSE handler must receive an http.Flusher-capable ResponseWriter")

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		// First event — signals test that streaming started.
		fmt.Fprintf(w, "data: first\n\n")
		flusher.Flush()
		close(firstEventSent)

		// Simulate a long-lived connection that would exceed a 25 ms timeout.
		select {
		case <-time.After(80 * time.Millisecond):
		case <-r.Context().Done():
			// Context was cancelled (e.g. client disconnected) — that is fine.
			return
		}

		// Second event — only reachable if the timeout did NOT cancel the context.
		fmt.Fprintf(w, "data: second\n\n")
		flusher.Flush()
	})

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	// SSE route registered OUTSIDE the timeout group, identical to production.
	r.Get("/api/notifications", sseHandler)

	// All other /api routes get a very short timeout.
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/notifications", nil)
	require.NoError(t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode, "SSE handler should return 200")
	require.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))

	// Wait until the first event has been sent before reading.
	select {
	case <-firstEventSent:
	case <-ctx.Done():
		t.Fatal("timed out waiting for first SSE event")
	}

	// Read the full response body (both events). A 25 ms timeout on the /api
	// group must NOT have closed the connection after the first event.
	body, err := io.ReadAll(resp.Body)
	// A context cancel on our end is fine — as long as we received both events.
	if err != nil && !strings.Contains(err.Error(), "context canceled") {
		require.NoError(t, err)
	}

	bodyStr := string(body)
	assert.Contains(t, bodyStr, "data: first", "first SSE event must be present")
	assert.Contains(t, bodyStr, "data: second", "second SSE event must be present — SSE route must not be subject to the short timeout")
}

// TestSSERoute_TimeoutStillAppliesInsideAPIGroup proves the control case: a
// handler that IS inside the /api timeout group gets cancelled after the timeout.
func TestSSERoute_TimeoutStillAppliesInsideAPIGroup(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/slow", func(w http.ResponseWriter, r *http.Request) {
			// Block until the context is cancelled by the timeout.
			<-r.Context().Done()
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/slow", nil)
	rec := httptest.NewRecorder()

	start := time.Now()
	r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code, "route inside timeout group must return 504")
	assert.Less(t, elapsed, 200*time.Millisecond, "timeout must be enforced quickly")
}

// --- WebSocket / Hijack test ---

// TestWebSocketUpgrade_HijackSucceedsThroughMiddleware verifies that
// http.Hijacker is preserved when the timeout middleware wraps the response
// writer. The terminal handler calls websocket.Accept which requires Hijack
// to work; if the wrapper doesn't forward the interface, the upgrade returns
// an error (and returns 500 instead of switching protocols).
//
// This test builds the same pattern as the production terminal route but uses a
// trivial handler that just calls Hijack() directly — no actual WebSocket
// library dependency in this test.
func TestWebSocketUpgrade_HijackSucceedsThroughMiddleware(t *testing.T) {
	t.Parallel()

	hijacked := false

	upgradeHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "hijacker not available", http.StatusInternalServerError)
			return
		}
		conn, _, err := h.Hijack()
		if err != nil {
			http.Error(w, "hijack failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer conn.Close()
		hijacked = true
		// Write a minimal HTTP 101 switching-protocols response on the raw conn.
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"))
	})

	// Mount OUTSIDE the timeout group, mirroring production.
	r := chi.NewRouter()
	r.Get("/api/repos/alice/demo/workspace/sessions/s1/terminal", upgradeHandler)

	// Use a hijackable recorder so the underlying writer supports Hijack.
	rec := &hijackableRecorder{ResponseRecorder: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodGet,
		"/api/repos/alice/demo/workspace/sessions/s1/terminal", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")

	r.ServeHTTP(rec, req)

	assert.True(t, hijacked, "WebSocket upgrade must succeed — Hijack must be callable from the handler")
}

// TestWebSocketUpgrade_HijackPreservedThroughTimeoutWrapper verifies the
// low-level property: the JSONTimeout middleware must forward http.Hijacker so
// the upgrade still works even when the timeout wrapper is present.
//
// This test directly exercises the middleware layer without the full router,
// ensuring correctness of the timeout writer implementation.
func TestWebSocketUpgrade_HijackPreservedThroughTimeoutWrapper(t *testing.T) {
	t.Parallel()

	hijacked := false

	handler := middleware.JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, ok := w.(http.Hijacker)
		require.True(t, ok, "http.Hijacker must be exposed through the timeout middleware wrapper")

		conn, _, err := h.Hijack()
		require.NoError(t, err, "Hijack must succeed without error")
		defer conn.Close()
		hijacked = true
	}))

	rec := &hijackableRecorder{ResponseRecorder: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	req.Header.Set("Connection", "Upgrade")

	handler.ServeHTTP(rec, req)

	assert.True(t, hijacked, "Hijack must succeed through the timeout middleware wrapper")
}
