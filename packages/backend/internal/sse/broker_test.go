package sse

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// immediateErrorNotifier fails its first wait so dispatch() exits at once.
type immediateErrorNotifier struct{}

func (immediateErrorNotifier) waitForNotificationWithChannel(context.Context) (string, string, error) {
	return "", "", context.Canceled
}
func (immediateErrorNotifier) release()                               {}
func (immediateErrorNotifier) listen(context.Context, string) error   { return nil }
func (immediateErrorNotifier) unlisten(context.Context, string) error { return nil }

// TestBrokerSubscribeFailsFastAfterDispatchExit locks the regression fix: once
// the dispatch goroutine dies (e.g. a lost Postgres connection), a subsequent
// Subscribe must return an error promptly instead of blocking forever on the
// unbuffered control channel.
func TestBrokerSubscribeFailsFastAfterDispatchExit(t *testing.T) {
	b := NewBroker(nil)
	b.conn = immediateErrorNotifier{}
	go b.dispatch()

	// Wait for dispatch to exit and signal connLost.
	select {
	case <-b.connLost:
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch did not exit / connLost not closed")
	}

	done := make(chan error, 1)
	go func() {
		_, err := b.Subscribe(context.Background(), "agent_session_x", 1)
		done <- err
	}()
	select {
	case err := <-done:
		require.Error(t, err, "Subscribe must fail fast after dispatch died")
	case <-time.After(2 * time.Second):
		t.Fatal("Subscribe hung after dispatch died (regression)")
	}
}

// TestBrokerListenHonorsContext ensures a caller's cancelled context unblocks a
// listen() waiting on the control channel (no dispatch goroutine draining it).
func TestBrokerListenHonorsContext(t *testing.T) {
	b := NewBroker(nil)
	b.conn = immediateErrorNotifier{}
	// Deliberately do NOT start dispatch(), so control is never drained.

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() {
		_, err := b.Subscribe(ctx, "agent_session_y", 1)
		done <- err
	}()
	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Subscribe ignored a cancelled context (regression)")
	}
}

// scriptedNotifier returns a real notification on its Nth wait call, simulating
// a NOTIFY that arrives exactly as a concurrent LISTEN control command cancels
// the wait.
type scriptedNotifier struct {
	mu      sync.Mutex
	calls   int
	hitOn   int
	channel string
	payload string
}

func (s *scriptedNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	s.mu.Lock()
	s.calls++
	n := s.calls
	s.mu.Unlock()
	<-ctx.Done()
	if n == s.hitOn {
		return s.channel, s.payload, nil
	}
	return "", "", ctx.Err()
}
func (s *scriptedNotifier) release()                               {}
func (s *scriptedNotifier) listen(context.Context, string) error   { return nil }
func (s *scriptedNotifier) unlisten(context.Context, string) error { return nil }

// TestBroker_ControlRace_DoesNotDropNotification locks finding 14: a NOTIFY that
// was already received when a control (LISTEN) command wins the dispatch select
// must still be delivered to existing subscribers, not silently discarded.
func TestBroker_ControlRace_DoesNotDropNotification(t *testing.T) {
	fake := &scriptedNotifier{hitOn: 2, channel: "chan_a", payload: "payload-1"}
	b := NewBroker(nil)
	b.conn = fake
	go b.dispatch()

	// First subscribe issues control cmd #1; the drained wait (#1) returns the
	// expected cancellation and is a no-op.
	subA, err := b.Subscribe(context.Background(), "chan_a", 1)
	require.NoError(t, err)
	defer b.Unsubscribe(subA)

	// Second subscribe issues control cmd #2; waitCancel() causes wait #2 to
	// return the real ("chan_a","payload-1") notification, which the buggy code
	// discarded.
	subB, err := b.Subscribe(context.Background(), "chan_b", 2)
	require.NoError(t, err)
	defer b.Unsubscribe(subB)

	select {
	case evt := <-subA.Events():
		assert.Equal(t, "chan_a", evt.Type)
		assert.Equal(t, "payload-1", evt.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("raced NOTIFY was dropped (regression)")
	}

	b.Stop()
}

// chanNotifier is a controllable fake connection: notifications are fed via
// notifs, and closing notifs simulates the Postgres connection dying.
type chanNotifier struct {
	notifs chan Event

	mu       sync.Mutex
	listens  []string
	released bool
}

func newChanNotifier() *chanNotifier {
	return &chanNotifier{notifs: make(chan Event)}
}

func (c *chanNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	select {
	case n, ok := <-c.notifs:
		if !ok {
			return "", "", errors.New("connection lost")
		}
		return n.Type, n.Data, nil
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
}

func (c *chanNotifier) release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.released = true
}

func (c *chanNotifier) listen(_ context.Context, channel string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listens = append(c.listens, channel)
	return nil
}

func (c *chanNotifier) unlisten(context.Context, string) error { return nil }

// TestBrokerReconnectsAfterConnectionLoss locks the self-healing fix: when the
// shared LISTEN connection dies (e.g. a Cloud SQL failover), the broker must
// disconnect stale subscribers (so their clients reconnect instead of hanging
// on keep-alives), re-acquire a fresh connection, and serve new subscriptions
// on it — instead of dying permanently until a pod restart.
func TestBrokerReconnectsAfterConnectionLoss(t *testing.T) {
	conn1 := newChanNotifier()
	conn2 := newChanNotifier()

	b := NewBroker(nil)
	b.conn = conn1
	b.acquireConn = func(context.Context) (brokerNotifier, error) { return conn2, nil }
	go b.dispatch()
	defer b.Stop()

	sub1, err := b.Subscribe(context.Background(), "chan_r", 1)
	require.NoError(t, err)

	// Kill the connection.
	close(conn1.notifs)

	// The stale subscriber must be disconnected so its EventSource reconnects
	// and replays via Last-Event-ID rather than silently missing events.
	select {
	case _, ok := <-sub1.Events():
		require.False(t, ok, "subscriber channel must be closed on connection loss")
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber was not disconnected after connection loss")
	}

	// A new subscribe must succeed on the fresh connection. It may fail fast
	// while the reconnect is still in flight, so retry briefly.
	var sub2 *Subscription
	require.Eventually(t, func() bool {
		s, subErr := b.Subscribe(context.Background(), "chan_r", 1)
		if subErr != nil {
			return false
		}
		sub2 = s
		return true
	}, 2*time.Second, 10*time.Millisecond, "Subscribe never recovered after connection loss")
	defer b.Unsubscribe(sub2)

	// Events delivered over the new connection must reach the new subscriber.
	select {
	case conn2.notifs <- Event{Type: "chan_r", Data: "after-reconnect"}:
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch never resumed waiting on the new connection")
	}
	select {
	case evt := <-sub2.Events():
		assert.Equal(t, "after-reconnect", evt.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("no event delivered after reconnect")
	}

	conn1.mu.Lock()
	released := conn1.released
	conn1.mu.Unlock()
	assert.True(t, released, "dead connection must be released back to the pool")

	conn2.mu.Lock()
	listens := append([]string(nil), conn2.listens...)
	conn2.mu.Unlock()
	assert.Contains(t, listens, "chan_r", "new connection must LISTEN for the re-subscribed channel")
}

// TestBrokerStopDuringReconnectBackoff ensures Stop() is not wedged by an
// in-flight reconnect loop whose acquire attempts keep failing.
func TestBrokerStopDuringReconnectBackoff(t *testing.T) {
	conn1 := newChanNotifier()
	b := NewBroker(nil)
	b.conn = conn1
	b.acquireConn = func(context.Context) (brokerNotifier, error) {
		return nil, errors.New("db down")
	}
	go b.dispatch()

	close(conn1.notifs)

	stopped := make(chan struct{})
	go func() {
		b.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop hung during reconnect backoff")
	}
}
