package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type gatewayPushStore struct {
	*mockWikiQuerier
	gatewayWikiUser
	sandboxHelperTokenStore
	rate func(context.Context, db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error)
}

func (q *gatewayPushStore) ConsumeSearchRateLimitToken(ctx context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	return q.rate(ctx, arg)
}

type gatewayPushAudit struct{ events []AuditEvent }

func (a *gatewayPushAudit) Log(_ context.Context, event AuditEvent) {
	a.events = append(a.events, event)
}

type gatewayPushCredentials struct{ gatewayWikiCredentials }

func (g gatewayPushCredentials) AuthorizeRelay(ctx context.Context, id, token string) (RepoGatewayRelayTarget, error) {
	target, err := g.gatewayWikiCredentials.AuthorizeRelay(ctx, id, token)
	target.GatewayID = "gateway"
	return target, err
}

func TestGatewayPushToken_MintRefusalsAndGitLifecycle(t *testing.T) {
	ctx := context.Background()
	permission := "write"
	archived := false
	var saved db.CreateAccessTokenParams
	var revoked bool
	var creates, rateCalls int
	rateAllowed := true
	var rateErr, createErr error
	q := &gatewayPushStore{
		mockWikiQuerier: &mockWikiQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				repo := sampleWikiRepository()
				repo.IsArchived = archived
				if arg.LowerName != "demo" {
					repo.ID = 900
				}
				return repo, nil
			},
			getCollaboratorPermissionForRepoFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return permission, nil
			},
		},
		sandboxHelperTokenStore: sandboxHelperTokenStore{
			createFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
				creates++
				saved = arg
				return db.AccessToken{ID: 7}, createErr
			},
			deleteFn: func(_ context.Context, arg db.DeleteAccessTokenParams) error {
				require.Equal(t, int64(7), arg.ID)
				require.Equal(t, int64(2), arg.UserID)
				revoked = true
				return nil
			},
		},
		rate: func(_ context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
			rateCalls++
			require.Equal(t, "gateway_push_token", arg.Scope)
			require.Equal(t, "gateway:gateway", arg.PrincipalKey)
			require.Equal(t, float64(3), arg.Capacity)
			require.Equal(t, 3.0/60, arg.RefillPerSecond)
			return db.ConsumeSearchRateLimitTokenRow{Allowed: rateAllowed}, rateErr
		},
	}
	audit := &gatewayPushAudit{}
	svc := &GatewayPushTokenService{gateway: gatewayPushCredentials{}, q: q, audit: audit}
	input := GatewayPushTokenInput{Repo: "alice/demo"}
	before := time.Now()
	result, err := svc.Mint(ctx, "gateway", "operator", input)
	require.NoError(t, err)
	require.Equal(t, int64(7), result.TokenID)
	require.Equal(t, int64(42), result.RepositoryID)
	require.Equal(t, "write:repository,repo:42", result.Scopes)
	require.Equal(t, result.Scopes, saved.Scopes)
	require.True(t, saved.ExpiresAt.Valid)
	require.Equal(t, saved.ExpiresAt.Time, result.ExpiresAt)
	require.WithinRange(t, result.ExpiresAt, before.Add(5*time.Minute), time.Now().Add(5*time.Minute))
	require.Equal(t, "sandbox-gateway-push-gateway", saved.Name)
	require.Equal(t, int64(2), saved.UserID)
	hash := sha256.Sum256([]byte(result.Token))
	require.Equal(t, hex.EncodeToString(hash[:]), saved.TokenHash)
	require.NotContains(t, saved.TokenHash, result.Token)
	require.Len(t, audit.events, 1)
	require.Equal(t, "token.create", audit.events[0].EventType)
	require.Equal(t, result.TokenID, *audit.events[0].TargetID)
	encoded, err := json.Marshal(audit.events)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), result.Token)

	// Pass the issued plaintext through the real smart-HTTP receive-pack path.
	// This fake models the SQL expiry predicate; the PostgreSQL test below also
	// verifies that predicate against the generated query.
	now := time.Now()
	gitQ := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(_ context.Context, hash string) (db.GetAuthInfoByTokenHashRow, error) {
			if revoked || hash != saved.TokenHash || !now.Before(saved.ExpiresAt.Time) {
				return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
			}
			return db.GetAuthInfoByTokenHashRow{ID: saved.UserID, IsActive: true, TokenID: 7, TokenScopes: saved.Scopes}, nil
		},
		getRepoByOwnerAndLowerNameFn: q.GetRepoByOwnerAndLowerName,
	}
	host := &mockGitHTTPRepoHostClient{}
	proxy := NewGitHTTPProxyService(gitQ, &mockGitHTTPAuthorizer{authorizeFn: func(_ context.Context, userID int64, _, _ string, mode AccessMode) error {
		require.Equal(t, int64(2), userID)
		require.Equal(t, AccessModeWrite, mode)
		return nil
	}}, host)
	push := func(repo string) error {
		return proxy.ProxyReceivePack(ctx, "alice", repo, result.Token, receivePackBody("refs/heads/feature", "refs/notes/review"), io.Discard)
	}
	require.NoError(t, push("demo"))
	require.Equal(t, 1, host.receivePackCall)
	// The mythical stack's refs are the stack service's alone, even for a
	// repository writer's gateway credential.
	require.Equal(t, 403, apiStatus(t, proxy.ProxyReceivePack(ctx, "alice", "demo", result.Token,
		receivePackBody("refs/heads/mythical", "refs/notes/mythical"), io.Discard)))
	require.Equal(t, 1, host.receivePackCall)
	require.Equal(t, 401, apiStatus(t, push("other")))
	now = result.ExpiresAt
	require.Equal(t, 401, apiStatus(t, push("demo")), "expiry boundary rejects the token")
	now = before
	revokeTemporaryRepoCloneToken(ctx, q, 2, result.TokenID)
	require.Equal(t, 401, apiStatus(t, push("demo")), "revoked PAT cannot reach receive-pack")
	require.Equal(t, 1, host.receivePackCall)

	for _, tc := range []struct {
		name, repo, bearer, permission string
		archived                       bool
		status                         int
	}{
		{"lost write", "alice/demo", "operator", "read", false, 403},
		{"no access", "alice/demo", "operator", "", false, 403},
		{"wrong repository", "alice/other", "operator", "write", false, 403},
		{"archived", "alice/demo", "operator", "write", true, 403},
		{"invalid operator", "alice/demo", "bad", "write", false, 401},
		{"invalid repository", "demo", "operator", "write", false, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			permission, archived = tc.permission, tc.archived
			got, err := svc.Mint(ctx, "gateway", tc.bearer, GatewayPushTokenInput{Repo: tc.repo})
			require.Equal(t, tc.status, apiStatus(t, err))
			require.Empty(t, got.Token)
			require.Equal(t, 1, creates)
			require.Equal(t, 1, rateCalls, "refusals do not consume another gateway's budget")
		})
	}
	permission, archived = "write", false
	rateAllowed = false
	_, err = svc.Mint(ctx, "gateway", "operator", input)
	require.Equal(t, 429, apiStatus(t, err))
	rateErr = errors.New("database offline")
	_, err = svc.Mint(ctx, "gateway", "operator", input)
	require.Equal(t, 503, apiStatus(t, err))
	require.Equal(t, 1, creates)
	rateAllowed, rateErr = true, nil
	createErr = errors.New("insert failed")
	got, err := svc.Mint(ctx, "gateway", "operator", input)
	require.Equal(t, 500, apiStatus(t, err))
	require.Empty(t, got.Token)
	require.Len(t, audit.events, 1, "failed mints must not produce success audits")
	require.True(t, middleware.ParseTokenScopes(result.Scopes).Has(middleware.ScopeWriteRepository))
}
