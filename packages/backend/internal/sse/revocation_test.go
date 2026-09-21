package sse

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// fakeWatcher yields the given event to a watcher whose principal it affects.
type fakeWatcher struct {
	event revocation.Event
	fire  chan struct{}
}

func (f *fakeWatcher) Watch(ctx context.Context, principal revocation.Principal) <-chan revocation.Event {
	ch := make(chan revocation.Event, 1)
	go func() {
		select {
		case <-ctx.Done():
		case <-f.fire:
			if f.event.Affects(principal) {
				ch <- f.event
			}
		}
	}()
	return ch
}

func TestServeBrokerSSE_EndsStreamWithRevokedEventWithinBound(t *testing.T) {
	t.Parallel()
	broker := newRunningBroker()
	watcher := &fakeWatcher{
		event: revocation.Event{ID: 3, Kind: revocation.KindTokenRevoked, TokenHash: "h1", Reason: "deleted"},
		fire:  make(chan struct{}),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		ServeBrokerSSE(rec, req, BrokerStreamConfig{
			Broker:      broker,
			Channel:     "user_notifications_1",
			UserID:      1,
			KeepAlive:   time.Hour,
			Revocations: watcher,
			Principal:   revocation.Principal{UserID: 1, TokenHash: "h1"},
		})
	}()
	// Let the stream connect, then revoke.
	time.Sleep(50 * time.Millisecond)
	started := time.Now()
	close(watcher.fire)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end within 5s of the revocation")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("stream ended after %s, want under 1s", elapsed)
	}
	body := rec.Body.String()
	if !strings.Contains(body, ": connected") {
		t.Fatalf("stream never connected: %q", body)
	}
	if !strings.Contains(body, "event: revoked") || !strings.Contains(body, `"reason":"deleted"`) {
		t.Fatalf("stream did not end with a revoked event: %q", body)
	}
}

func TestServeBrokerSSE_UnrelatedRevocationKeepsStreaming(t *testing.T) {
	t.Parallel()
	broker := newRunningBroker()
	watcher := &fakeWatcher{
		event: revocation.Event{ID: 4, Kind: revocation.KindTokenRevoked, TokenHash: "someone-else"},
		fire:  make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ServeBrokerSSE(rec, req, BrokerStreamConfig{
			Broker:      broker,
			Channel:     "user_notifications_1",
			UserID:      1,
			KeepAlive:   time.Hour,
			Revocations: watcher,
			Principal:   revocation.Principal{UserID: 1, TokenHash: "h1"},
		})
	}()
	time.Sleep(50 * time.Millisecond)
	close(watcher.fire)
	select {
	case <-done:
		t.Fatal("stream ended on an unrelated revocation")
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	<-done
	if strings.Contains(rec.Body.String(), "event: revoked") {
		t.Fatal("unrelated revocation was written to the stream")
	}
}

// quietNotifier is a broker connection that never delivers a notification and
// accepts every LISTEN, so a test broker can subscribe without PostgreSQL.
type quietNotifier struct{}

func (quietNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	<-ctx.Done()
	return "", "", ctx.Err()
}
func (quietNotifier) release()                               {}
func (quietNotifier) listen(context.Context, string) error   { return nil }
func (quietNotifier) unlisten(context.Context, string) error { return nil }

func newRunningBroker() *Broker {
	b := NewBroker(nil)
	b.conn = quietNotifier{}
	go b.dispatch()
	return b
}
