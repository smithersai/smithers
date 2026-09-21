package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateAccessToken_WithExpiresAt(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "token-expires-user")

	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	token, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "expiring-token",
		TokenHash:      "token-hash-expires",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, userID, token.UserID)
	assert.True(t, token.ExpiresAt.Valid)
	assert.WithinDuration(t, expiresAt, token.ExpiresAt.Time, time.Second)
}

// TestCreateAccessToken_WithoutExpiresAt verifies that a token can be created without an expiration time.
func TestCreateAccessToken_WithoutExpiresAt(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "token-no-expires-user")

	token, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "non-expiring-token",
		TokenHash:      "token-hash-no-expires",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Valid: false},
	})
	require.NoError(t, err)
	assert.Equal(t, userID, token.UserID)
	assert.False(t, token.ExpiresAt.Valid)
}

// TestGetAuthInfoByTokenHash_ExpiredTokenRejected verifies that an expired token is rejected.
func TestGetAuthInfoByTokenHash_ExpiredTokenRejected(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "expired-token-user")

	// Create a token that expired in the past.
	expiresAt := time.Now().UTC().Add(-1 * time.Hour)
	_, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "expired-token",
		TokenHash:      "token-hash-expired",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	require.NoError(t, err)

	// Query should return no rows because the token is expired
	_, err = q.GetAuthInfoByTokenHash(context.Background(), "token-hash-expired")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

// TestGetAuthInfoByTokenHash_ValidTokenSucceeds verifies that a valid (non-expired) token works.
func TestGetAuthInfoByTokenHash_ValidTokenSucceeds(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "valid-token-user")

	// Create a token that expires in the future
	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	_, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "valid-token",
		TokenHash:      "token-hash-valid",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	require.NoError(t, err)

	// Query should succeed because the token is valid
	authInfo, err := q.GetAuthInfoByTokenHash(context.Background(), "token-hash-valid")
	require.NoError(t, err)
	assert.Equal(t, userID, authInfo.ID)
	assert.Equal(t, "read:repository", authInfo.TokenScopes)
}

// TestGetAuthInfoByTokenHash_NonExpiringTokenSucceeds verifies that a token without expiration works.
func TestGetAuthInfoByTokenHash_NonExpiringTokenSucceeds(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "non-expiring-token-user")

	// Create a token without expiration
	_, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "never-expires-token",
		TokenHash:      "token-hash-never-expires",
		TokenLastEight: "89abcdef",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Valid: false},
	})
	require.NoError(t, err)

	// Query should succeed because the token never expires
	authInfo, err := q.GetAuthInfoByTokenHash(context.Background(), "token-hash-never-expires")
	require.NoError(t, err)
	assert.Equal(t, userID, authInfo.ID)
	assert.Equal(t, "read:repository", authInfo.TokenScopes)
}

// TestDeleteExpiredAccessTokens verifies that expired tokens are cleaned up.
func TestDeleteExpiredAccessTokens(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "cleanup-token-user")

	// Create a token that will be expired
	_, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "stale-token",
		TokenHash:      "token-hash-stale",
		TokenLastEight: "11111111",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Time: time.Now().UTC().Add(10 * time.Minute), Valid: true},
	})
	require.NoError(t, err)

	// Create a token that will remain valid
	fresh, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "fresh-token",
		TokenHash:      "token-hash-fresh",
		TokenLastEight: "22222222",
		Scopes:         "write:repository",
		ExpiresAt:      pgtype.Timestamptz{Time: time.Now().UTC().Add(10 * time.Minute), Valid: true},
	})
	require.NoError(t, err)

	// Manually expire the stale token. DeleteExpiredAccessTokens only prunes
	// past the documented 1-day grace window, so push it well beyond that.
	mustExec(
		t,
		pool,
		`UPDATE access_tokens SET expires_at = NOW() - interval '2 days' WHERE token_hash = $1`,
		"token-hash-stale",
	)

	// Run the cleanup
	_, err = q.DeleteExpiredAccessTokens(context.Background())
	require.NoError(t, err)

	// Verify only the fresh token remains
	var count int
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM access_tokens WHERE user_id = $1`,
		userID,
	).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// Verify the fresh token is still accessible
	_, err = q.GetAccessTokenByID(context.Background(), fresh.ID)
	require.NoError(t, err)
}

// TestDeleteExpiredAccessTokens_NoExpiryNotDeleted verifies that tokens without expiration are not deleted.
func TestDeleteExpiredAccessTokens_NoExpiryNotDeleted(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "no-expiry-cleanup-user")

	// Create a token without expiration
	created, err := q.CreateAccessToken(context.Background(), CreateAccessTokenParams{
		UserID:         userID,
		Name:           "permanent-token",
		TokenHash:      "token-hash-permanent",
		TokenLastEight: "33333333",
		Scopes:         "read:repository",
		ExpiresAt:      pgtype.Timestamptz{Valid: false},
	})
	require.NoError(t, err)

	// Run the cleanup
	_, err = q.DeleteExpiredAccessTokens(context.Background())
	require.NoError(t, err)

	// Verify the token still exists
	token, err := q.GetAccessTokenByID(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, "permanent-token", token.Name)
}
