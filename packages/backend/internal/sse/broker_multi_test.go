package sse

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestBrokerSubscribeMulti_FansInAndCountsOnce verifies that a multi-channel
// subscription (a) receives NOTIFYs from every channel it registered under, each
// tagged with the originating channel, and (b) counts as exactly one stream
// against the per-user cap.
func TestBrokerSubscribeMulti_FansInAndCountsOnce(t *testing.T) {
	fake := &brokerCovSequenceNotifier{notifications: make(chan brokerCovNotification, 4)}
	b := NewBroker(nil)
	b.conn = fake
	go b.dispatch()
	defer b.Stop()

	sub, err := b.SubscribeMulti(context.Background(), []string{"chan_a", "chan_b", "chan_c"}, 42)
	require.NoError(t, err)

	// One subscription => one cap slot for the user.
	b.mu.Lock()
	count := b.userCounts[42]
	b.mu.Unlock()
	assert.Equal(t, 1, count, "multi-channel subscription must count once against the per-user cap")

	// A NOTIFY on any registered channel fans in to the single subscription,
	// tagged with the originating channel.
	fake.notifications <- brokerCovNotification{channel: "chan_b", payload: "from-b"}
	select {
	case evt := <-sub.Events():
		assert.Equal(t, "chan_b", evt.Type)
		assert.Equal(t, "from-b", evt.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("multi-channel subscription did not receive fan-in notification")
	}

	fake.notifications <- brokerCovNotification{channel: "chan_c", payload: "from-c"}
	select {
	case evt := <-sub.Events():
		assert.Equal(t, "chan_c", evt.Type)
		assert.Equal(t, "from-c", evt.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("multi-channel subscription did not receive second fan-in notification")
	}
}

// TestBrokerSubscribeMulti_CapExhaustion confirms the per-user cap is enforced
// once across the whole multi-channel subscription, not once per channel.
func TestBrokerSubscribeMulti_CapExhaustion(t *testing.T) {
	b := NewBroker(nil)
	b.MaxStreamsPerUser = 1
	b.conn = brokerCovNopNotifier{}
	go b.dispatch()
	defer b.Stop()

	first, err := b.SubscribeMulti(context.Background(), []string{"a", "b"}, 7)
	require.NoError(t, err)

	_, err = b.SubscribeMulti(context.Background(), []string{"c"}, 7)
	var tooMany *ErrTooManyStreams
	require.ErrorAs(t, err, &tooMany)
	assert.Equal(t, int64(7), tooMany.UserID)

	b.Unsubscribe(first)
	b.mu.Lock()
	_, present := b.userCounts[7]
	b.mu.Unlock()
	assert.False(t, present, "user count must return to zero after unsubscribing the sole subscription")
}

// TestBrokerSubscribeMulti_UnsubscribeRemovesFromAllChannels ensures a
// multi-channel subscriber is removed from every channel slice and its chan is
// closed exactly once.
func TestBrokerSubscribeMulti_UnsubscribeRemovesFromAllChannels(t *testing.T) {
	b := NewBroker(nil)
	b.conn = brokerCovNopNotifier{}
	go b.dispatch()
	defer b.Stop()

	sub, err := b.SubscribeMulti(context.Background(), []string{"x", "y", "z"}, 3)
	require.NoError(t, err)

	b.Unsubscribe(sub)

	b.mu.Lock()
	for _, ch := range []string{"x", "y", "z"} {
		assert.Empty(t, b.subscribers[ch], "subscriber must be removed from channel %q", ch)
	}
	b.mu.Unlock()

	// The event channel must be closed (range loop terminates).
	select {
	case _, ok := <-sub.Events():
		assert.False(t, ok, "event channel must be closed after Unsubscribe")
	case <-time.After(2 * time.Second):
		t.Fatal("event channel was not closed after Unsubscribe")
	}

	// A second Unsubscribe must be a harmless no-op (no double close panic).
	require.NotPanics(t, func() { b.Unsubscribe(sub) })
}

// TestBrokerStop_NoDoubleCloseForMultiChannelSubscriber locks the critical
// regression: a subscriber registered under N channels is present in N slices,
// so a naive Stop() close loop would close its chan N times and panic. Stop must
// dedupe closes.
func TestBrokerStop_NoDoubleCloseForMultiChannelSubscriber(t *testing.T) {
	b := NewBroker(nil)
	b.conn = brokerCovNopNotifier{}
	go b.dispatch()

	_, err := b.SubscribeMulti(context.Background(), []string{"m1", "m2", "m3"}, 9)
	require.NoError(t, err)

	require.NotPanics(t, b.Stop, "Stop must close each subscriber chan exactly once")
}
