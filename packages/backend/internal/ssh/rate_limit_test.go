package ssh

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestAuthLimiter_PerIPThrottle(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 2,
		MaxAuthFailures:   5,
		InitialBan:        15 * time.Minute,
		MaxBan:            24 * time.Hour,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.9", ""))
	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.9", ""))
	assert.Equal(t, AuthLimitThrottled, limiter.Check("203.0.113.9", ""))

	now = now.Add(time.Minute)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.9", ""))
}

func TestAuthLimiter_BansAfterConfiguredFailures(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 50,
		MaxAuthFailures:   3,
		InitialBan:        10 * time.Second,
		MaxBan:            time.Minute,
		Now: func() time.Time {
			return now
		},
	})

	for i := 0; i < 3; i++ {
		assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.10", ""))
		limiter.RecordFailure("198.51.100.10", "")
	}

	assert.Equal(t, AuthLimitBanned, limiter.Check("198.51.100.10", ""))
	now = now.Add(11 * time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.10", ""))
}

func TestAuthLimiter_ExponentialBackoffBanCapsAtMax(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 50,
		MaxAuthFailures:   1,
		InitialBan:        2 * time.Second,
		MaxBan:            5 * time.Second,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("192.0.2.20", ""))
	limiter.RecordFailure("192.0.2.20", "")
	assert.Equal(t, AuthLimitBanned, limiter.Check("192.0.2.20", ""))

	now = now.Add(3 * time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("192.0.2.20", ""))
	limiter.RecordFailure("192.0.2.20", "")
	assert.Equal(t, AuthLimitBanned, limiter.Check("192.0.2.20", ""))

	now = now.Add(5 * time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("192.0.2.20", ""))
	limiter.RecordFailure("192.0.2.20", "")
	assert.Equal(t, AuthLimitBanned, limiter.Check("192.0.2.20", ""))

	now = now.Add(6 * time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("192.0.2.20", ""))
}

func TestAuthLimiter_RecordSuccessResetsFailureStreak(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 50,
		MaxAuthFailures:   2,
		InitialBan:        10 * time.Second,
		MaxBan:            time.Minute,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.44", ""))
	limiter.RecordFailure("203.0.113.44", "")
	limiter.RecordSuccess("203.0.113.44", "")

	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.44", ""))
	limiter.RecordFailure("203.0.113.44", "")
	assert.Equal(t, AuthLimitAllowed, limiter.Check("203.0.113.44", ""))
}

func TestAuthLimiter_IsolatesThrottleAndBanPerIP(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 1,
		MaxAuthFailures:   1,
		InitialBan:        10 * time.Second,
		MaxBan:            time.Minute,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.1", ""))
	limiter.RecordFailure("198.51.100.1", "")
	assert.Equal(t, AuthLimitBanned, limiter.Check("198.51.100.1", ""))

	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.2", ""))
	assert.Equal(t, AuthLimitThrottled, limiter.Check("198.51.100.2", ""))
	assert.Equal(t, AuthLimitBanned, limiter.Check("198.51.100.1", ""))
}

func TestAuthLimiter_EvictsExpiredStates(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 10,
		MaxAuthFailures:   2,
		InitialBan:        10 * time.Second,
		MaxBan:            time.Minute,
		StateTTL:          5 * time.Minute,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.10", ""))
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.11", ""))
	assert.Len(t, limiter.states, 2)

	now = now.Add(6 * time.Minute)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.12", ""))

	assert.Len(t, limiter.states, 1)
	_, ok := limiter.states["198.51.100.12"]
	assert.True(t, ok, "new state should be retained after eviction")
}

func TestAuthLimiter_EvictsOldestStateWhenCapReached(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 10,
		MaxAuthFailures:   2,
		InitialBan:        10 * time.Second,
		MaxBan:            time.Minute,
		StateTTL:          time.Hour,
		MaxTrackedIPs:     2,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.10", ""))
	now = now.Add(time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.11", ""))
	now = now.Add(time.Second)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.12", ""))

	assert.Len(t, limiter.states, 2)
	_, evicted := limiter.states["198.51.100.10"]
	assert.False(t, evicted, "oldest state should be evicted when cap is reached")
	_, retained := limiter.states["198.51.100.12"]
	assert.True(t, retained, "newest state should be tracked")
}
