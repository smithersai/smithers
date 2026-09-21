package db

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func consumeRateLimit(t *testing.T, q *Queries, scope, key string, capacity, refillPerSecond float64, now time.Time) ConsumeSearchRateLimitTokenRow {
	t.Helper()
	result, err := q.ConsumeSearchRateLimitToken(context.Background(), ConsumeSearchRateLimitTokenParams{
		Scope:           scope,
		PrincipalKey:    key,
		Capacity:        capacity,
		RefillPerSecond: refillPerSecond,
		NowAt:           now,
	})
	require.NoError(t, err)
	return result
}

func TestConsumeSearchRateLimitToken_FirstCallSeedsAndSecondCallWorks(t *testing.T) {
	q, _ := newQueries(t)

	now := time.Now().UTC().Truncate(time.Second)

	// First call seeds and consumes one token.
	first := consumeRateLimit(t, q, "search", "user:seed-test", 5, 1, now)
	assert.True(t, first.Allowed)
	assert.InDelta(t, 4.0, first.RemainingTokens, 0.01)

	second := consumeRateLimit(t, q, "search", "user:seed-test", 5, 1, now)
	assert.True(t, second.Allowed)
	assert.InDelta(t, 3.0, second.RemainingTokens, 0.01)
}

func TestConsumeSearchRateLimitToken_AllowsWithinCapacity(t *testing.T) {
	q, _ := newQueries(t)

	now := time.Now().UTC().Truncate(time.Second)

	// Consume all 5 tokens.
	var result ConsumeSearchRateLimitTokenRow
	for i := 0; i < 5; i++ {
		result = consumeRateLimit(t, q, "search", "user:1", 5, 1, now)
		assert.True(t, result.Allowed, "consume %d should be allowed", i+1)
	}
	assert.InDelta(t, 0.0, result.RemainingTokens, 0.01)

	// Now the bucket should be empty — next consume should be denied.
	result, err := q.ConsumeSearchRateLimitToken(context.Background(), ConsumeSearchRateLimitTokenParams{
		Scope:           "search",
		PrincipalKey:    "user:1",
		Capacity:        5,
		RefillPerSecond: 1,
		NowAt:           now,
	})
	require.NoError(t, err)
	assert.False(t, result.Allowed, "should be denied when bucket is empty")
	assert.InDelta(t, 0.0, result.RemainingTokens, 0.01)
}

func TestConsumeSearchRateLimitToken_RefillsOverTime(t *testing.T) {
	q, _ := newQueries(t)

	now := time.Now().UTC().Truncate(time.Second)

	// Drain the bucket.
	for i := 0; i < 3; i++ {
		consumeRateLimit(t, q, "search", "user:refill", 3, 1, now)
	}

	// Verify bucket is empty.
	result, err := q.ConsumeSearchRateLimitToken(context.Background(), ConsumeSearchRateLimitTokenParams{
		Scope:           "search",
		PrincipalKey:    "user:refill",
		Capacity:        3,
		RefillPerSecond: 1,
		NowAt:           now,
	})
	require.NoError(t, err)
	assert.False(t, result.Allowed)

	// Advance time by 2 seconds — should refill 2 tokens.
	later := now.Add(2 * time.Second)
	result, err = q.ConsumeSearchRateLimitToken(context.Background(), ConsumeSearchRateLimitTokenParams{
		Scope:           "search",
		PrincipalKey:    "user:refill",
		Capacity:        3,
		RefillPerSecond: 1,
		NowAt:           later,
	})
	require.NoError(t, err)
	assert.True(t, result.Allowed, "should be allowed after refill")
	assert.InDelta(t, 1.0, result.RemainingTokens, 0.01, "should have 1 remaining after consuming from refilled bucket")
}

func TestConsumeSearchRateLimitToken_IsolatesScopesAndPrincipals(t *testing.T) {
	q, _ := newQueries(t)

	now := time.Now().UTC().Truncate(time.Second)

	// Consume from scope A / user 10.
	r1 := consumeRateLimit(t, q, "code_search", "user:10", 2, 1, now)
	assert.True(t, r1.Allowed)

	// Different scope same principal — separate bucket.
	r2 := consumeRateLimit(t, q, "issue_search", "user:10", 2, 1, now)
	assert.True(t, r2.Allowed)
	assert.InDelta(t, 1.0, r2.RemainingTokens, 0.01, "different scope should have independent bucket")

	// Same scope different principal.
	r3 := consumeRateLimit(t, q, "code_search", "user:20", 2, 1, now)
	assert.True(t, r3.Allowed)
	assert.InDelta(t, 1.0, r3.RemainingTokens, 0.01, "different principal should have independent bucket")
}

func TestDeleteExpiredSearchRateLimits_DeletesOldRecords(t *testing.T) {
	q, pool := newQueries(t)

	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-24 * time.Hour)

	// Seed two rate limit records with different timestamps.
	consumeRateLimit(t, q, "search", "old-user", 5, 1, old)
	consumeRateLimit(t, q, "search", "fresh-user", 5, 1, now)

	// Delete records older than 1 hour ago.
	cutoff := now.Add(-1 * time.Hour)
	err := q.DeleteExpiredSearchRateLimits(context.Background(), cutoff)
	require.NoError(t, err)

	// Old record should be gone, fresh should remain.
	var count int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM search_rate_limits`).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count, "only fresh record should remain")

	var remaining string
	err = pool.QueryRow(context.Background(), `SELECT principal_key FROM search_rate_limits`).Scan(&remaining)
	require.NoError(t, err)
	assert.Equal(t, "fresh-user", remaining)
}
