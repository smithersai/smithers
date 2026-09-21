package services

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitHubBudget_Z_RefillClampAndNegativeRemaining(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTrackerWithLimits(2, time.Minute)
	tracker.now = func() time.Time { return now }

	allowed, retryAfter := tracker.Allow(99)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	allowed, _ = tracker.Allow(99)
	require.True(t, allowed)

	now = now.Add(2 * time.Minute)
	allowed, _ = tracker.Allow(99)
	require.True(t, allowed)
	assert.Equal(t, 1, tracker.Remaining(99))

	tracker.mu.Lock()
	tracker.buckets[100] = &budgetEntry{tokens: -0.5, lastRefill: now}
	tracker.mu.Unlock()
	assert.Equal(t, 0, tracker.Remaining(100))
}

func TestGitHubBudget_Z_StatusAndRefusalShareReset(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTrackerWithLimits(2, time.Minute)
	tracker.now = func() time.Time { return now }

	fresh := tracker.Status(44)
	assert.Equal(t, GitHubRateLimit{
		Limit:     2,
		Remaining: 2,
		ResetAt:   now.Add(time.Minute),
	}, fresh)

	allowed, retryAfter, status := tracker.AllowWithStatus(44)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	assert.Equal(t, GitHubRateLimit{
		Limit:     2,
		Remaining: 1,
		ResetAt:   now.Add(30 * time.Second),
	}, status)

	allowed, retryAfter, status = tracker.AllowWithStatus(44)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	assert.Equal(t, 0, status.Remaining)
	assert.Equal(t, now.Add(time.Minute), status.ResetAt)

	allowed, retryAfter, refused := tracker.AllowWithStatus(44)
	require.False(t, allowed)
	assert.Equal(t, time.Minute, retryAfter)
	assert.Equal(t, status, refused)
}
