package email

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRateLimitedTransport_NoLimitsReturnsInner(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{})

	// Should return the inner transport directly when no limits set.
	assert.Equal(t, inner, wrapped)
}

func TestRateLimitedTransport_DelegatesAvailability(t *testing.T) {
	t.Parallel()

	disabled := NewRateLimitedTransport(&DisabledTransport{}, RateLimitConfig{
		MaxPerSecond:           10,
		MaxPerRecipientPerHour: 20,
	})
	assert.False(t, DeliveryConfigured(disabled))

	available := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerSecond:           10,
		MaxPerRecipientPerHour: 20,
	})
	assert.True(t, DeliveryConfigured(available))
}

func TestRateLimitedTransport_GlobalRateLimit(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 2,
	})

	msg := Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}

	// First two should succeed.
	require.NoError(t, wrapped.Send(context.Background(), msg))
	require.NoError(t, wrapped.Send(context.Background(), msg))

	// Third should be rate limited.
	err := wrapped.Send(context.Background(), msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "global rate limit exceeded")
}

func TestRateLimitedTransport_PerRecipientRateLimit(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 2,
	})

	msgAlice := Message{
		To:      []string{"alice@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}
	msgBob := Message{
		To:      []string{"bob@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}

	// Alice: first two should succeed.
	require.NoError(t, wrapped.Send(context.Background(), msgAlice))
	require.NoError(t, wrapped.Send(context.Background(), msgAlice))

	// Alice: third should fail.
	err := wrapped.Send(context.Background(), msgAlice)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "per-recipient rate limit exceeded")
	assert.Contains(t, err.Error(), "alice@example.com")

	// Bob: should still work (different recipient).
	require.NoError(t, wrapped.Send(context.Background(), msgBob))
}

func TestRateLimitedTransport_PrunesExpiredRecipientWindows(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 10,
	}).(*RateLimitedTransport)

	expiredMsg := Message{
		To:      []string{"expired@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}
	freshMsg := Message{
		To:      []string{"fresh@example.com"},
		Subject: "Test",
		Text:    "Hello",
	}

	require.NoError(t, tr.Send(context.Background(), expiredMsg))

	tr.mu.Lock()
	w := tr.recipientCounts["expired@example.com"]
	require.NotNil(t, w)
	w.resetAt = time.Now().Add(-time.Minute)
	tr.mu.Unlock()

	require.NoError(t, tr.Send(context.Background(), freshMsg))

	tr.mu.Lock()
	_, expiredExists := tr.recipientCounts["expired@example.com"]
	fresh := tr.recipientCounts["fresh@example.com"]
	count := len(tr.recipientCounts)
	tr.mu.Unlock()

	assert.False(t, expiredExists)
	require.NotNil(t, fresh)
	assert.Equal(t, 1, fresh.count)
	assert.Equal(t, 1, count)
}

func TestRateLimitedTransport_DelegatesToInner(t *testing.T) {
	t.Parallel()

	inner := &NoopTransport{}
	wrapped := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 100,
	})

	msg := Message{
		To:      []string{"user@example.com"},
		Subject: "Delegated",
		Text:    "Hello",
	}

	require.NoError(t, wrapped.Send(context.Background(), msg))
	require.Len(t, inner.Sent, 1)
	assert.Equal(t, "Delegated", inner.Sent[0].Subject)
}
