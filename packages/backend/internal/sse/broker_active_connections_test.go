package sse

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestBrokerActiveConnections verifies the gauge the admin status endpoint reads:
// one subscription counts once no matter how many channels it fans in, the total
// spans users, and unsubscribing releases the slot.
func TestBrokerActiveConnections(t *testing.T) {
	b := NewBroker(nil)
	b.conn = brokerCovNopNotifier{}
	go b.dispatch()
	defer b.Stop()

	assert.Equal(t, 0, b.ActiveConnections(), "a broker with no subscribers reports zero")

	first, err := b.Subscribe(context.Background(), "chan_a", 1)
	require.NoError(t, err)
	assert.Equal(t, 1, b.ActiveConnections())

	// A multi-channel subscription is one stream, matching the per-user cap.
	second, err := b.SubscribeMulti(context.Background(), []string{"chan_b", "chan_c"}, 2)
	require.NoError(t, err)
	assert.Equal(t, 2, b.ActiveConnections())

	third, err := b.Subscribe(context.Background(), "chan_d", 2)
	require.NoError(t, err)
	assert.Equal(t, 3, b.ActiveConnections(), "counts span users")

	b.Unsubscribe(second)
	assert.Equal(t, 2, b.ActiveConnections())

	b.Unsubscribe(first)
	b.Unsubscribe(third)
	assert.Equal(t, 0, b.ActiveConnections())
}

// TestBrokerActiveConnectionsNil locks the nil-receiver contract: the status
// aggregate wires the broker unconditionally.
func TestBrokerActiveConnectionsNil(t *testing.T) {
	var b *Broker
	assert.Equal(t, 0, b.ActiveConnections())
}
