package sse

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordingNotifier is a brokerNotifier fake that records the channels it was
// asked to UNLISTEN, so tests can assert the broker reclaims idle channels
// instead of leaking them on the single shared connection.
type recordingNotifier struct {
	mu        sync.Mutex
	unlistens []string
}

func (n *recordingNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	<-ctx.Done()
	return "", "", ctx.Err()
}

func (n *recordingNotifier) release()                             {}
func (n *recordingNotifier) listen(context.Context, string) error { return nil }

func (n *recordingNotifier) unlisten(_ context.Context, channel string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.unlistens = append(n.unlistens, channel)
	return nil
}

func (n *recordingNotifier) recorded() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]string, len(n.unlistens))
	copy(out, n.unlistens)
	return out
}

// drainClosed drains any buffered events on ch and reports whether the channel
// is closed (as opposed to merely empty).
func drainClosed(ch <-chan Event) bool {
	for i := 0; i < subscriberBufSize+2; i++ {
		select {
		case _, ok := <-ch:
			if !ok {
				return true
			}
		default:
		}
	}
	return false
}

// TestBrokerDispatch_DisconnectsSlowSubscriber locks the fix for the silent,
// unrecoverable event-loss finding: when a subscriber's buffer is full,
// dispatchNotification must DISCONNECT it (close its channel) rather than
// silently drop the event, so its EventSource reconnects and replays via
// Last-Event-ID. A silent drop would keep the HTTP connection open forever.
func TestBrokerDispatch_DisconnectsSlowSubscriber(t *testing.T) {
	rec := &recordingNotifier{}
	b := NewBroker(nil)
	b.conn = rec

	s := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 1, channels: []string{"room"}}
	b.mu.Lock()
	b.subscribers["room"] = []*subscriber{s}
	b.channels["room"] = struct{}{}
	b.userCounts[1] = 1
	b.mu.Unlock()

	// Fill the buffer so the next notification cannot be enqueued.
	for i := 0; i < subscriberBufSize; i++ {
		s.ch <- Event{}
	}

	b.dispatchNotification("room", "overflow")

	require.True(t, drainClosed(s.ch),
		"slow subscriber must be disconnected (channel closed), not silently dropped")

	// The now-idle channel must be UNLISTENed and both maps reclaimed.
	b.mu.Lock()
	_, stillListening := b.channels["room"]
	_, stillPresent := b.subscribers["room"]
	count := b.userCounts[1]
	b.mu.Unlock()
	assert.False(t, stillListening, "idle channel must be UNLISTENed after slow-client disconnect")
	assert.False(t, stillPresent, "subscriber slice must be reclaimed after slow-client disconnect")
	assert.Zero(t, count, "per-user count must be released when the slow subscriber is disconnected")
	assert.Equal(t, []string{"room"}, rec.recorded())
}

// TestBrokerDispatch_KeepsHealthySubscribersOnDisconnect ensures disconnecting a
// slow subscriber does not disturb a healthy one sharing the same channel, and
// that a channel with a remaining subscriber is NOT UNLISTENed.
func TestBrokerDispatch_KeepsHealthySubscribersOnDisconnect(t *testing.T) {
	rec := &recordingNotifier{}
	b := NewBroker(nil)
	b.conn = rec

	slow := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 1, channels: []string{"room"}}
	fast := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 2, channels: []string{"room"}}
	b.mu.Lock()
	b.subscribers["room"] = []*subscriber{slow, fast}
	b.channels["room"] = struct{}{}
	b.userCounts[1] = 1
	b.userCounts[2] = 1
	b.mu.Unlock()

	for i := 0; i < subscriberBufSize; i++ {
		slow.ch <- Event{}
	}

	b.dispatchNotification("room", "payload")

	require.True(t, drainClosed(slow.ch), "slow subscriber must be disconnected")

	select {
	case evt := <-fast.ch:
		assert.Equal(t, "room", evt.Type)
		assert.Equal(t, "payload", evt.Data)
	default:
		t.Fatal("healthy subscriber must still receive the event")
	}

	b.mu.Lock()
	_, stillListening := b.channels["room"]
	remaining := len(b.subscribers["room"])
	b.mu.Unlock()
	assert.True(t, stillListening, "channel with a remaining subscriber must stay LISTENed")
	assert.Equal(t, 1, remaining)
	assert.Empty(t, rec.recorded(), "must not UNLISTEN a channel that still has subscribers")
}

// TestBrokerUnsubscribe_UnlistensIdleChannel locks the connection-leak fix: when
// the last subscriber for a channel unsubscribes, the broker UNLISTENs and drops
// the channel so the LISTEN set on the single shared connection does not grow
// without bound (e.g. per-workflow-step channels).
func TestBrokerUnsubscribe_UnlistensIdleChannel(t *testing.T) {
	rec := &recordingNotifier{}
	b := NewBroker(nil)
	b.conn = rec
	go b.dispatch()
	defer b.Stop()

	sub, err := b.Subscribe(context.Background(), "workflow_step_logs_42", 5)
	require.NoError(t, err)

	b.mu.Lock()
	_, listening := b.channels["workflow_step_logs_42"]
	b.mu.Unlock()
	require.True(t, listening, "Subscribe should have LISTENed the channel")

	b.Unsubscribe(sub)

	b.mu.Lock()
	_, stillListening := b.channels["workflow_step_logs_42"]
	_, stillPresent := b.subscribers["workflow_step_logs_42"]
	b.mu.Unlock()
	assert.False(t, stillListening, "idle channel must be UNLISTENed after the last unsubscribe")
	assert.False(t, stillPresent, "subscriber map entry must be reclaimed after the last unsubscribe")
	assert.Equal(t, []string{"workflow_step_logs_42"}, rec.recorded())
}

// TestBrokerUnsubscribe_KeepsSharedChannelListening ensures a channel with other
// subscribers is not UNLISTENed when one of them leaves.
func TestBrokerUnsubscribe_KeepsSharedChannelListening(t *testing.T) {
	rec := &recordingNotifier{}
	b := NewBroker(nil)
	b.conn = rec
	go b.dispatch()
	defer b.Stop()

	subA, err := b.Subscribe(context.Background(), "shared_channel", 1)
	require.NoError(t, err)
	subB, err := b.Subscribe(context.Background(), "shared_channel", 2)
	require.NoError(t, err)

	b.Unsubscribe(subA)

	b.mu.Lock()
	_, listening := b.channels["shared_channel"]
	remaining := len(b.subscribers["shared_channel"])
	b.mu.Unlock()
	assert.True(t, listening, "channel must stay LISTENed while subB remains")
	assert.Equal(t, 1, remaining)
	assert.Empty(t, rec.recorded(), "must not UNLISTEN while a subscriber remains")

	b.Unsubscribe(subB)
	b.mu.Lock()
	_, stillListening := b.channels["shared_channel"]
	b.mu.Unlock()
	assert.False(t, stillListening, "channel must be UNLISTENed once the last subscriber leaves")
	assert.Equal(t, []string{"shared_channel"}, rec.recorded())
}

// TestBrokerUnlistenIfIdle_SkipsWhenSubscribeInFlight locks the race guard: a
// channel with an in-flight Subscribe (pendingSubs > 0) must NOT be UNLISTENed,
// so a subscriber that skipped the idempotent LISTEN is never left on a
// no-longer-listening channel.
func TestBrokerUnlistenIfIdle_SkipsWhenSubscribeInFlight(t *testing.T) {
	rec := &recordingNotifier{}
	b := NewBroker(nil)
	b.conn = rec

	b.mu.Lock()
	b.channels["c"] = struct{}{}
	b.pendingSubs["c"] = 1 // a Subscribe is racing this UNLISTEN
	err := b.unlistenIfIdleLocked("c")
	_, stillListening := b.channels["c"]
	b.mu.Unlock()

	require.NoError(t, err)
	assert.True(t, stillListening, "must not UNLISTEN while a subscribe is in flight for the channel")
	assert.Empty(t, rec.recorded())
}

// TestBrokerUnsubscribe_NoUnlistenWithoutConnection ensures Unsubscribe never
// blocks issuing UNLISTEN when the broker was never started (no dispatch/conn),
// which would otherwise deadlock on the unbuffered control channel.
func TestBrokerUnsubscribe_NoUnlistenWithoutConnection(t *testing.T) {
	b := NewBroker(nil) // no conn, no dispatch goroutine

	s := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 3, channels: []string{"room"}}
	b.subscribers["room"] = []*subscriber{s}
	b.channels["room"] = struct{}{}
	b.userCounts[3] = 1
	sub := &Subscription{broker: b, channels: []string{"room"}, sub: s}

	done := make(chan struct{})
	go func() {
		b.Unsubscribe(sub)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Unsubscribe hung issuing UNLISTEN with no dispatch goroutine (regression)")
	}
	require.True(t, drainClosed(s.ch), "Unsubscribe must still close the subscriber channel")
}
