package email

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// RateLimitConfig controls how many emails can be sent within a window.
type RateLimitConfig struct {
	// MaxPerSecond is the maximum number of emails per second (0 = unlimited).
	MaxPerSecond int
	// MaxPerRecipientPerHour limits emails to a single recipient per hour (0 = unlimited).
	MaxPerRecipientPerHour int
}

// RateLimitedTransport wraps a Transport and enforces rate limits on email sends.
type RateLimitedTransport struct {
	inner Transport
	cfg   RateLimitConfig
	mu    sync.Mutex
	// global rate limiting: sliding window token bucket
	tokens    int
	lastReset time.Time
	// per-recipient rate limiting
	recipientCounts map[string]*recipientWindow
}

type recipientWindow struct {
	count   int
	resetAt time.Time
}

// NewRateLimitedTransport wraps a transport with rate limiting.
// If cfg has all zero values, the inner transport is returned directly.
func NewRateLimitedTransport(inner Transport, cfg RateLimitConfig) Transport {
	if cfg.MaxPerSecond == 0 && cfg.MaxPerRecipientPerHour == 0 {
		return inner
	}
	return &RateLimitedTransport{
		inner:           inner,
		cfg:             cfg,
		tokens:          cfg.MaxPerSecond,
		lastReset:       time.Now(),
		recipientCounts: make(map[string]*recipientWindow),
	}
}

// Available delegates provider availability through the rate-limit wrapper.
// Rate limiting changes admission to Send; it does not make a disabled inner
// transport capable of delivery.
func (t *RateLimitedTransport) Available() bool {
	return t != nil && DeliveryConfigured(t.inner)
}

// Send checks rate limits before delegating to the inner transport.
func (t *RateLimitedTransport) Send(ctx context.Context, msg Message) error {
	t.mu.Lock()
	err := t.checkLimits(msg)
	t.mu.Unlock()
	if err != nil {
		return err
	}
	return t.inner.Send(ctx, msg)
}

func (t *RateLimitedTransport) checkLimits(msg Message) error {
	now := time.Now()

	// Global rate limit: refill tokens every second.
	if t.cfg.MaxPerSecond > 0 {
		elapsed := now.Sub(t.lastReset)
		if elapsed >= time.Second {
			t.tokens = t.cfg.MaxPerSecond
			t.lastReset = now
		}
		if t.tokens <= 0 {
			return fmt.Errorf("email: global rate limit exceeded (%d/sec)", t.cfg.MaxPerSecond)
		}
		t.tokens--
	}

	// Per-recipient rate limit.
	if t.cfg.MaxPerRecipientPerHour > 0 {
		for recipient, w := range t.recipientCounts {
			if now.After(w.resetAt) {
				delete(t.recipientCounts, recipient)
			}
		}
		for _, recipient := range msg.To {
			w, exists := t.recipientCounts[recipient]
			if !exists {
				t.recipientCounts[recipient] = &recipientWindow{
					count:   1,
					resetAt: now.Add(time.Hour),
				}
				continue
			}
			if w.count >= t.cfg.MaxPerRecipientPerHour {
				return fmt.Errorf("email: per-recipient rate limit exceeded for %s (%d/hour)", recipient, t.cfg.MaxPerRecipientPerHour)
			}
			w.count++
		}
	}

	return nil
}
