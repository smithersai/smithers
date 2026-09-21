package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type sandboxHelperTokenStore struct {
	createFn func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error)
	deleteFn func(context.Context, db.DeleteAccessTokenParams) error
}

func (s sandboxHelperTokenStore) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if s.createFn != nil {
		return s.createFn(ctx, arg)
	}
	return db.AccessToken{ID: 1, UserID: arg.UserID}, nil
}

func (s sandboxHelperTokenStore) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	if s.deleteFn != nil {
		return s.deleteFn(ctx, arg)
	}
	return nil
}

func TestIssueTemporaryRepoCloneTokenSetsExpiry(t *testing.T) {
	t.Parallel()

	before := time.Now().UTC()
	var captured db.CreateAccessTokenParams
	store := sandboxHelperTokenStore{
		createFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			captured = arg
			return db.AccessToken{ID: 10, UserID: arg.UserID}, nil
		},
	}

	token, err := issueTemporaryRepoCloneToken(context.Background(), store, 42, "sandbox-agent-clone")
	require.NoError(t, err)
	assert.Equal(t, int64(10), token.ID)
	assert.True(t, strings.HasPrefix(token.Plaintext, "smithers_"))
	assert.Equal(t, int64(42), captured.UserID)
	assert.Equal(t, "read:repository", captured.Scopes)
	require.True(t, captured.ExpiresAt.Valid)
	assert.True(t, captured.ExpiresAt.Time.After(before.Add(temporaryRepoTokenTTL-time.Minute)))
	assert.True(t, captured.ExpiresAt.Time.Before(time.Now().UTC().Add(temporaryRepoTokenTTL+time.Minute)))
}

func TestRevokeTemporaryRepoCloneTokenDetachesFromCanceledContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	called := false
	store := sandboxHelperTokenStore{
		deleteFn: func(got context.Context, arg db.DeleteAccessTokenParams) error {
			called = true
			assert.NoError(t, got.Err())
			assert.Equal(t, int64(99), arg.ID)
			assert.Equal(t, int64(42), arg.UserID)
			if _, ok := got.Deadline(); !ok {
				t.Fatal("revoke context should have a timeout")
			}
			return nil
		},
	}

	revokeTemporaryRepoCloneToken(ctx, store, 42, 99)
	assert.True(t, called)
}

func TestBuildAuthenticatedRepoCloneURL_Success(t *testing.T) {
	t.Parallel()

	url, err := buildAuthenticatedRepoCloneURL("https://api.smithers.sh", "alice", "demo", "smithers_token123")
	require.NoError(t, err)
	assert.Contains(t, url, "alice/demo.git")
	assert.Contains(t, url, "x-access-token:smithers_token123@")
	assert.Contains(t, url, "https://")
}

func TestBuildAuthenticatedRepoCloneURL_EmptyBaseURL(t *testing.T) {
	t.Parallel()

	_, err := buildAuthenticatedRepoCloneURL("", "alice", "demo", "token")
	require.Error(t, err)
}

func TestBuildAuthenticatedRepoCloneURL_EmptyOwner(t *testing.T) {
	t.Parallel()

	_, err := buildAuthenticatedRepoCloneURL("https://api.smithers.sh", "", "demo", "token")
	require.Error(t, err)
}

func TestBuildAuthenticatedRepoCloneURL_EmptyToken(t *testing.T) {
	t.Parallel()

	_, err := buildAuthenticatedRepoCloneURL("https://api.smithers.sh", "alice", "demo", "")
	require.Error(t, err)
}

func TestBuildAuthenticatedRepoCloneURL_MissingScheme(t *testing.T) {
	t.Parallel()

	_, err := buildAuthenticatedRepoCloneURL("api.smithers.sh", "alice", "demo", "token")
	require.Error(t, err)
}

func TestNormalizePublicBaseURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected string
	}{
		{"https://api.smithers.sh/api", "https://api.smithers.sh"},
		{"https://api.smithers.sh/api/", "https://api.smithers.sh"},
		{"https://api.smithers.sh", "https://api.smithers.sh"},
		{"https://api.smithers.sh/", "https://api.smithers.sh"},
		{"  https://api.smithers.sh  ", "https://api.smithers.sh"},
	}

	for _, tt := range tests {
		result := normalizePublicBaseURL(tt.input)
		assert.Equal(t, tt.expected, result, "input: %q", tt.input)
	}
}

func TestOptionalVMID(t *testing.T) {
	t.Parallel()

	t.Run("non-empty", func(t *testing.T) {
		result := optionalVMID("vm-123")
		assert.True(t, result.Valid)
		assert.Equal(t, "vm-123", result.String)
	})

	t.Run("empty", func(t *testing.T) {
		result := optionalVMID("")
		assert.False(t, result.Valid)
	})

	t.Run("whitespace only", func(t *testing.T) {
		result := optionalVMID("   ")
		assert.Equal(t, pgtype.Text{String: "", Valid: false}, result)
	})
}
