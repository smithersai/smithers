package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGitHubRepoReadAuthorized_AsksGitHubWithTheCallersCredential(t *testing.T) {
	f := newPrivateRepoFixture(t)
	ctx := context.Background()
	const userA, userB = int64(1), int64(2)

	assert.False(t, f.userService("", false).GitHubRepoReadAuthorized(ctx, userB, "acme", "secret"),
		"no GitHub credential is no proof")
	assert.False(t, f.userService("gho_b", true).GitHubRepoReadAuthorized(ctx, userB, "acme", "secret"))
	assert.True(t, f.contacted("Bearer gho_b"), "GitHub decides user B's access")

	assert.True(t, f.userService("gho_a", true).GitHubRepoReadAuthorized(ctx, userA, "acme", "secret"))
	assert.True(t, f.synced.ReadGrant(ctx, userA, "acme", "secret").ok, "a live proof stamps the caller's grant")
	assert.False(t, f.synced.ReadGrant(ctx, userB, "acme", "secret").ok, "and only the caller's")

	// A fresh grant answers without asking GitHub again, even with a token
	// GitHub would refuse.
	assert.True(t, f.userService("gho_revoked", true).GitHubRepoReadAuthorized(ctx, userA, "acme", "secret"))
	assert.False(t, f.contacted("Bearer gho_revoked"))
}
