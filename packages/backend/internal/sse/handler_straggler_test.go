package sse

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestHandler_Straggler_ServeSSEExitsOnContextCancel covers the stream loop's
// `case <-r.Context().Done(): return` branch: with no events published, the
// only way out of ServeSSE's loop is the request context being cancelled
// (client disconnect).
func TestHandler_Straggler_ServeSSEExitsOnContextCancel(t *testing.T) {
	applicationName := handlerCovChannel("handler_straggler_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	channel := handlerCovChannel("handler_straggler")

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeSSE(rec, req, StreamConfig{
			Pool:     pool,
			Channels: []string{channel},
			OnConnect: func(_ http.ResponseWriter, _ *http.Request, _ http.Flusher) {
				close(ready)
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("ServeSSE did not connect")
	}

	// No NOTIFY is ever sent, so canceling the request context is the sole
	// path out of the select loop.
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("ServeSSE did not return after request context cancel")
	}
}
