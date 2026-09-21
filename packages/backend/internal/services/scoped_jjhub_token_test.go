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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// TestIssueTemporaryRepoAPIToken_ScopesAndTTL verifies the per-run scoped jjhub
// API token is minted with write:repository (which implies read:repository)
// BOUND to the run's repository, a ~24h expiry, and a single-use plaintext.
func TestIssueTemporaryRepoAPIToken_ScopesAndTTL(t *testing.T) {
	t.Parallel()

	before := time.Now().UTC()
	var captured db.CreateAccessTokenParams
	store := sandboxHelperTokenStore{
		createFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			captured = arg
			return db.AccessToken{ID: 7, UserID: arg.UserID, Name: arg.Name}, nil
		},
	}

	token, err := issueTemporaryRepoAPIToken(context.Background(), store, 42, 314, "sandbox-run-10", "src/**", "README.md")
	require.NoError(t, err)

	assert.Equal(t, int64(7), token.ID)
	assert.True(t, len(token.Plaintext) > len("smithers_"))
	assert.Equal(t, int64(42), captured.UserID)
	assert.Equal(t, "sandbox-run-10", captured.Name)

	// write:repository is stored (implying read:repository) together with the
	// repo:<id> binding, so the token authorizes ONLY the run's repository.
	pathScopes := middleware.PathRestrictionScopes([]string{"src/**", "README.md"})
	assert.Equal(t, string(middleware.ScopeWriteRepository)+",repo:314,"+strings.Join(pathScopes, ","), captured.Scopes)
	parsed := middleware.ParseTokenScopes(captured.Scopes)
	assert.True(t, parsed.Has(middleware.ScopeWriteRepository))
	assert.True(t, parsed.Has(middleware.ScopeReadRepository))
	assert.Equal(t, int64(314), middleware.ParseTokenRepositoryRestriction(captured.Scopes))
	assert.Equal(t, []string{"src/**", "README.md"}, middleware.ParseTokenPathRestrictions(captured.Scopes))

	// Expiry ≈ now + 24h (perRunAPITokenTTL), NOT the 1h clone token TTL.
	require.True(t, captured.ExpiresAt.Valid)
	assert.True(t, captured.ExpiresAt.Time.After(before.Add(perRunAPITokenTTL-time.Minute)))
	assert.True(t, captured.ExpiresAt.Time.Before(time.Now().UTC().Add(perRunAPITokenTTL+time.Minute)))
}

// TestIssueTemporaryRepoAPIToken_RequiresRepositoryBinding verifies a per-run
// token can never be minted without a repository binding (the unbound token is
// exactly the cross-repo blast radius this guards against).
func TestIssueTemporaryRepoAPIToken_RequiresRepositoryBinding(t *testing.T) {
	t.Parallel()

	store := sandboxHelperTokenStore{
		createFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			t.Fatal("no token must be created without a repository binding")
			return db.AccessToken{}, nil
		},
	}

	_, err := issueTemporaryRepoAPIToken(context.Background(), store, 42, 0, "sandbox-run-11")
	require.Error(t, err)
}

func TestIssueTemporaryAgentRepoAPIToken_BindsAuthorSession(t *testing.T) {
	t.Parallel()
	var captured db.CreateAccessTokenParams
	store := sandboxHelperTokenStore{createFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
		captured = arg
		return db.AccessToken{ID: 8}, nil
	}}
	sessionID := "11111111-1111-4111-8111-111111111111"
	_, err := issueTemporaryAgentRepoAPIToken(context.Background(), store, 42, 314, "sandbox-run-12", sessionID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, middleware.ParseTokenAgentSessionRestriction(captured.Scopes))
	assert.Equal(t, int64(314), middleware.ParseTokenRepositoryRestriction(captured.Scopes))
}

// TestRevokeAgentSessionJJHubToken_RevokesThenClears verifies the terminal-path
// helper loads the persisted token id, deletes the access token scoped to the
// owning user, and clears the id from the run.
func TestRevokeAgentSessionJJHubToken_RevokesThenClears(t *testing.T) {
	t.Parallel()

	var (
		deletedID     int64
		deletedUserID int64
		clearedRunID  int64
	)
	dq := &mockAgentDispatchQuerier{
		getWorkflowRunJJHubTokenIDFn: func(ctx context.Context, id int64) (pgtype.Int8, error) {
			assert.Equal(t, int64(500), id)
			return pgtype.Int8{Int64: 321, Valid: true}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			deletedID = arg.ID
			deletedUserID = arg.UserID
			return nil
		},
		clearWorkflowRunJJHubTokenIDFn: func(ctx context.Context, id int64) error {
			clearedRunID = id
			return nil
		},
	}

	svc := &AgentService{dispatchQ: dq}
	svc.revokeAgentSessionJJHubToken(context.Background(), 42, pgtype.Int8{Int64: 500, Valid: true})

	assert.Equal(t, int64(321), deletedID)
	assert.Equal(t, int64(42), deletedUserID)
	assert.Equal(t, int64(500), clearedRunID)
}

// TestRevokeAgentSessionJJHubToken_NoTokenIsNoop verifies that when no token id
// is persisted the helper does not attempt a delete or clear.
func TestRevokeAgentSessionJJHubToken_NoTokenIsNoop(t *testing.T) {
	t.Parallel()

	deleteCalled := false
	clearCalled := false
	dq := &mockAgentDispatchQuerier{
		getWorkflowRunJJHubTokenIDFn: func(ctx context.Context, id int64) (pgtype.Int8, error) {
			return pgtype.Int8{Valid: false}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			deleteCalled = true
			return nil
		},
		clearWorkflowRunJJHubTokenIDFn: func(ctx context.Context, id int64) error {
			clearCalled = true
			return nil
		},
	}

	svc := &AgentService{dispatchQ: dq}
	svc.revokeAgentSessionJJHubToken(context.Background(), 42, pgtype.Int8{Int64: 1, Valid: true})
	// Also a no-op when the run id itself is absent.
	svc.revokeAgentSessionJJHubToken(context.Background(), 42, pgtype.Int8{Valid: false})

	assert.False(t, deleteCalled, "delete must not be called when no token is persisted")
	assert.False(t, clearCalled, "clear must not be called when no token is persisted")
}

// TestFinalizeAgentSession_RevokesJJHubToken verifies the terminal finalize path
// revokes the per-run scoped API token (no leak after the run ends).
func TestFinalizeAgentSession_RevokesJJHubToken(t *testing.T) {
	t.Parallel()

	deleted := false
	dq := &mockAgentDispatchQuerier{
		getWorkflowRunJJHubTokenIDFn: func(ctx context.Context, id int64) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: 777, Valid: true}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			assert.Equal(t, int64(777), arg.ID)
			assert.Equal(t, int64(9), arg.UserID)
			deleted = true
			return nil
		},
	}

	svc := &AgentService{dispatchQ: dq}
	session := db.AgentSession{
		ID:            "sess-final",
		UserID:        9,
		WorkflowRunID: pgtype.Int8{Int64: 500, Valid: true},
	}
	svc.finalizeAgentSession(context.Background(), session, "completed", "")

	assert.True(t, deleted, "finalize should revoke the per-run jjhub token")
}

// TestApplyReservedRuntimeEnv_RepoSecretCannotOverride verifies that reserved
// runtime env (agent token + API base, and the per-run scoped jjhub token + base)
// is restored even after a repo secret has overwritten it. This closes the
// escalation where a repo admin sets a malicious SMITHERS_JJHUB_API_URL (or
// SMITHERS_JJHUB_TOKEN) to redirect/capture the run owner's cross-repo write token.
func TestApplyReservedRuntimeEnv_RepoSecretCannotOverride(t *testing.T) {
	t.Parallel()

	svc := &AgentService{apiBaseURL: "https://api.jjhub.tech"}
	d := &agentDispatch{
		svc:           svc,
		plaintext:     "agent-callback-token",
		hasJJHubToken: true,
		jjhubToken:    temporaryRepoCloneToken{ID: 5, Plaintext: "jjhub-scoped-token"},
	}
	// Simulate the state after injectSecrets: a malicious repo secret has
	// overwritten every reserved key.
	d.agentServiceSpec.Env = map[string]string{
		"SMITHERS_AGENT_TOKEN":   "attacker",
		"SMITHERS_API_BASE_URL":  "https://bob.evil",
		"SMITHERS_JJHUB_TOKEN":   "attacker",
		"SMITHERS_JJHUB_API_URL": "https://bob.evil",
	}

	d.applyReservedRuntimeEnv()

	want := normalizePublicBaseURL(svc.apiBaseURL)
	assert.Equal(t, "agent-callback-token", d.agentServiceSpec.Env["SMITHERS_AGENT_TOKEN"])
	assert.Equal(t, want, d.agentServiceSpec.Env["SMITHERS_API_BASE_URL"])
	assert.Equal(t, "jjhub-scoped-token", d.agentServiceSpec.Env["SMITHERS_JJHUB_TOKEN"])
	assert.Equal(t, want, d.agentServiceSpec.Env["SMITHERS_JJHUB_API_URL"])
}
