package sse

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// parseSSEFields returns every "field: value" line of one serialized event.
func parseSSEFields(t *testing.T, s string) []string {
	t.Helper()
	var fields []string
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		if line := sc.Text(); line != "" {
			fields = append(fields, line)
		}
	}
	return fields
}

// FormatEvent must keep every emitted line inside its own field: a payload
// newline cannot smuggle a retry:, event:, or blank-line frame boundary.
func TestFormatEvent_NewlinesCannotInjectFields(t *testing.T) {
	out := FormatEvent(Event{
		ID:   "1\nretry: 0",
		Type: "log\r\ndata: spoof",
		Data: "line1\nretry: 0\r\n\r\nevent: spoof\rline3",
	})

	require.True(t, strings.HasSuffix(out, "\n\n"))
	body := strings.TrimSuffix(out, "\n\n")
	assert.NotContains(t, body, "\n\n", "payload must not end the event early")
	assert.NotContains(t, body, "\r", "bare CR is a line terminator in SSE")

	for _, f := range parseSSEFields(t, out) {
		assert.True(t,
			strings.HasPrefix(f, "id: ") || strings.HasPrefix(f, "event: ") || strings.HasPrefix(f, "data: ") || f == "data:",
			"unexpected SSE field %q", f)
	}
	assert.Equal(t, 1, strings.Count(out, "\nevent: ")+boolInt(strings.HasPrefix(out, "event: ")))
	assert.NotContains(t, out, "\nretry:")
	// The data lines, rejoined by the client with \n, carry the payload.
	assert.Contains(t, out, "data: line1\ndata: retry: 0\ndata: \ndata: event: spoof\ndata: line3\n")
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestKeepAliveInterval_NonPositiveUsesDefault(t *testing.T) {
	assert.Equal(t, defaultKeepAlive, keepAliveInterval(0))
	assert.Equal(t, defaultKeepAlive, keepAliveInterval(-time.Second))
	assert.Equal(t, 3*time.Second, keepAliveInterval(3*time.Second))
}

// A negative KeepAlive must not panic after the 200 stream has been committed.
func TestServeBrokerSSE_NegativeKeepAliveDoesNotPanic(t *testing.T) {
	conn := newChanNotifier()
	b := NewBroker(nil)
	b.conn = conn
	go b.dispatch()
	defer b.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	require.NotPanics(t, func() {
		ServeBrokerSSE(rec, req, BrokerStreamConfig{Broker: b, Channel: "chan_ka", UserID: 1, KeepAlive: -time.Second})
	})
	assert.Equal(t, http.StatusOK, rec.Code)
}

// stuckNotifier ignores cancellation, like a wedged pgx call.
type stuckNotifier struct {
	unblock   chan struct{}
	released  atomic.Bool
	discarded atomic.Bool
}

func (n *stuckNotifier) waitForNotificationWithChannel(context.Context) (string, string, error) {
	<-n.unblock
	return "", "", context.Canceled
}
func (n *stuckNotifier) release()                               { n.released.Store(true) }
func (n *stuckNotifier) discard()                               { n.discarded.Store(true); close(n.unblock) }
func (n *stuckNotifier) listen(context.Context, string) error   { return nil }
func (n *stuckNotifier) unlisten(context.Context, string) error { return nil }

// When dispatch does not exit in time, Stop must discard the physical
// connection, never return it to the pool while dispatch may still use it.
func TestBrokerStop_StragglerDispatchDiscardsConnection(t *testing.T) {
	prev := brokerStopTimeout
	brokerStopTimeout = 50 * time.Millisecond
	t.Cleanup(func() { brokerStopTimeout = prev })

	n := &stuckNotifier{unblock: make(chan struct{})}
	b := NewBroker(nil)
	b.conn = n
	b.dispatching.Store(true)
	go b.dispatch()
	time.Sleep(10 * time.Millisecond)

	b.Stop()

	assert.False(t, n.released.Load(), "straggling connection was returned to the pool")
	assert.True(t, n.discarded.Load(), "straggling connection was not discarded")
}
