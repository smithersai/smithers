package email

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRatelimit_Cover_GlobalRefillAfterWindow exercises the token refill branch
// in checkLimits: once a full second has elapsed since lastReset, the bucket is
// refilled to MaxPerSecond and the send succeeds again.
func TestRatelimit_Cover_GlobalRefillAfterWindow(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerSecond: 1}).(*RateLimitedTransport)

	msg := Message{To: []string{"user@example.com"}, Subject: "s", Text: "t"}

	// First send consumes the only token.
	require.NoError(t, tr.Send(context.Background(), msg))

	// Without a refill the next send would be rate limited. Rewind lastReset so
	// that more than a second has "elapsed", forcing the refill branch.
	tr.mu.Lock()
	tr.lastReset = time.Now().Add(-2 * time.Second)
	tr.mu.Unlock()

	require.NoError(t, tr.Send(context.Background(), msg))

	// Bucket is exhausted again immediately after the refilled token is spent.
	err := tr.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "global rate limit exceeded")

	require.Len(t, inner.Sent, 2)
}

// TestRatelimit_Cover_PerRecipientExpiredWindowRecreated exercises the
// per-recipient expired-window path: when resetAt has passed, the old window is
// pruned and the send succeeds with a fresh window instead of being rejected.
func TestRatelimit_Cover_PerRecipientExpiredWindowRecreated(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerRecipientPerHour: 1}).(*RateLimitedTransport)

	msg := Message{To: []string{"user@example.com"}, Subject: "s", Text: "t"}

	// First send creates the recipient window with count 1.
	require.NoError(t, tr.Send(context.Background(), msg))

	// A second send in the same window would exceed the limit.
	err := tr.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "per-recipient rate limit exceeded")

	// Expire the window so it is pruned and recreated on the next send.
	tr.mu.Lock()
	w := tr.recipientCounts["user@example.com"]
	require.NotNil(t, w)
	w.resetAt = time.Now().Add(-time.Minute)
	tr.mu.Unlock()

	require.NoError(t, tr.Send(context.Background(), msg))

	// The window was recreated, so count is back to 1.
	tr.mu.Lock()
	got := tr.recipientCounts["user@example.com"].count
	tr.mu.Unlock()
	assert.Equal(t, 1, got)
}
