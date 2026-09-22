package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
	"github.com/stretchr/testify/require"
)

// Uses the real gateway authenticator, PAT store, permission resolver and SQL
// expiry predicate. Only the final repo-host receive-pack transport is stubbed.
func TestGatewayPushToken_PostgresLifecycle(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := deploymentdb.New(pool)
	ownerID, repoID := setupTestUserAndRepo(t, pool)
	actorID, otherRepoID := setupTestUserAndRepo(t, pool)
	owner, err := q.GetUserByID(ctx, ownerID)
	require.NoError(t, err)
	actor, err := q.GetUserByID(ctx, actorID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	otherRepo, err := q.GetRepoByID(ctx, otherRepoID)
	require.NoError(t, err)
	_, err = q.AddCollaborator(ctx, db.AddCollaboratorParams{RepositoryID: repoID, UserID: pgtypeInt8(actorID), Permission: "write"})
	require.NoError(t, err)
	gateway, err := q.CreateRepoGateway(ctx, clusterdb.CreateRepoGatewayParams{RepositoryID: repoID, UserID: actorID, Status: "running"})
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("operator"))
	_, err = q.UpdateRepoGatewayExecutionInfo(ctx, clusterdb.UpdateRepoGatewayExecutionInfoParams{ID: gateway.ID, VmID: "vm-test", AuthTokenHash: hex.EncodeToString(hash[:]), Status: "running"})
	require.NoError(t, err)
	service := NewGatewayPushTokenService(NewRepoGatewayService(q), q, NewAuditService(q))
	input := GatewayPushTokenInput{Repo: owner.Username + "/" + repo.Name}
	result, err := service.Mint(ctx, gateway.ID, "operator", input)
	require.NoError(t, err)
	stored, err := q.GetAccessTokenByID(ctx, result.TokenID)
	require.NoError(t, err)
	require.Equal(t, actorID, stored.UserID)
	require.Equal(t, result.Scopes, stored.Scopes)
	require.WithinDuration(t, result.ExpiresAt, stored.ExpiresAt.Time, time.Microsecond)
	var auditMetadata string
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata::text FROM audit_log WHERE event_type='token.create' AND target_id=$1`, result.TokenID).Scan(&auditMetadata))
	require.Contains(t, auditMetadata, gateway.ID)
	require.NotContains(t, auditMetadata, result.Token)
	host := &mockGitHTTPRepoHostClient{}
	proxy := NewGitHTTPProxyService(q, NewSSHAuthorizationService(q), host)
	push := func(token, owner, name string) error {
		return proxy.ProxyReceivePack(ctx, owner, name, token, receivePackBody("refs/heads/mythical", "refs/notes/mythical"), io.Discard)
	}
	require.NoError(t, push(result.Token, owner.Username, repo.Name))
	require.Equal(t, 401, apiStatus(t, push(result.Token, actor.Username, otherRepo.Name)), "PAT cannot push another repository even when its user owns it")
	_, err = service.Mint(ctx, gateway.ID, "operator", GatewayPushTokenInput{Repo: actor.Username + "/" + otherRepo.Name})
	require.Equal(t, 403, apiStatus(t, err))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='read' WHERE repository_id=$1 AND user_id=$2`, repoID, actorID)
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.Equal(t, 403, apiStatus(t, err))
	require.Equal(t, 403, apiStatus(t, push(result.Token, owner.Username, repo.Name)))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE repository_id=$1 AND user_id=$2`, repoID, actorID)
	require.NoError(t, err)
	require.NoError(t, q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: result.TokenID, UserID: actorID}))
	require.Equal(t, 401, apiStatus(t, push(result.Token, owner.Username, repo.Name)))
	result, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.NoError(t, err)
	// Advance only this credential's expiry to avoid a five-minute wall-clock
	// sleep while exercising the actual GetAuthInfoByTokenHash SQL predicate.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, result.TokenID)
	require.NoError(t, err)
	hash = sha256.Sum256([]byte(result.Token))
	_, err = q.GetAuthInfoByTokenHash(ctx, hex.EncodeToString(hash[:]))
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.Equal(t, 401, apiStatus(t, push(result.Token, owner.Username, repo.Name)))
	require.Equal(t, 1, host.receivePackCall)
	_, err = pool.Exec(ctx, `UPDATE repositories SET is_archived=true WHERE id=$1`, repoID)
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.Equal(t, 403, apiStatus(t, err))
	_, err = pool.Exec(ctx, `UPDATE repositories SET is_archived=false WHERE id=$1`, repoID)
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.NoError(t, err, "third mint fits the burst budget")
	// A fresh service instance and alternate UUID spelling share the DB budget.
	service = NewGatewayPushTokenService(NewRepoGatewayService(q), q, NewAuditService(q))
	_, err = service.Mint(ctx, strings.ToUpper(gateway.ID), "operator", input)
	require.Equal(t, 429, apiStatus(t, err))
	_, err = pool.Exec(ctx, `UPDATE search_rate_limits SET last_refill_at=now()-interval '21 seconds' WHERE scope='gateway_push_token' AND principal_key=$1`, "gateway:"+gateway.ID)
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.NoError(t, err, "budget refills")
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, actorID)
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.Equal(t, 401, apiStatus(t, err))
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, actorID)
	require.NoError(t, err)
	_, err = q.UpdateRepoGatewayStatus(ctx, clusterdb.UpdateRepoGatewayStatusParams{ID: gateway.ID, Status: "stopped"})
	require.NoError(t, err)
	_, err = service.Mint(ctx, gateway.ID, "operator", input)
	require.Equal(t, 409, apiStatus(t, err))
}
