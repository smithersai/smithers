package ssh

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRateLimit_H_DefaultLimiterUsesAllDefaults(t *testing.T) {
	t.Parallel()

	limiter := NewDefaultAuthLimiter()

	require.NotNil(t, limiter)
	assert.Equal(t, defaultAuthAttemptsPerMinute, limiter.attemptsPerMinute)
	assert.Equal(t, defaultAuthMaxFailures, limiter.maxAuthFailures)
	assert.Equal(t, defaultAuthInitialBan, limiter.initialBan)
	assert.Equal(t, defaultAuthMaxBan, limiter.maxBan)
	assert.Equal(t, defaultAuthStateTTL, limiter.stateTTL)
	assert.Equal(t, defaultAuthMaxTrackedIPs, limiter.maxTrackedIPs)
	require.NotNil(t, limiter.nowFn)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.200", ""))
}

func TestRateLimit_H_ClampsMaxBanAndStateTTL(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	limiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 10,
		MaxAuthFailures:   3,
		InitialBan:        time.Hour,
		MaxBan:            time.Minute,
		StateTTL:          time.Minute,
		MaxTrackedIPs:     7,
		Now: func() time.Time {
			return now
		},
	})

	assert.Equal(t, time.Hour, limiter.maxBan)
	assert.Equal(t, time.Hour, limiter.stateTTL)
	assert.Equal(t, AuthLimitAllowed, limiter.Check("198.51.100.201", ""))
}

func TestRateLimit_H_EvictOldestStatesEmptyMapReturns(t *testing.T) {
	t.Parallel()

	limiter := &AuthLimiter{
		maxTrackedIPs: 0,
		states:        map[string]*authIPState{},
	}

	limiter.evictOldestStates(limiter.states, 1)
	assert.Empty(t, limiter.states)
}

func TestRateLimit_H_NormalizeBlankIP(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "unknown", normalizeIPKey(" \t\n "))
}

func TestRateLimit_H_BanDurationCapsInitialOverMax(t *testing.T) {
	t.Parallel()

	limiter := &AuthLimiter{
		initialBan: 10 * time.Minute,
		maxBan:     time.Minute,
	}

	assert.Equal(t, time.Minute, limiter.banDuration(0))
}
