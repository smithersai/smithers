package services

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const gatewayPushTokenTTL = 5 * time.Minute

type GatewayPushTokenQuerier interface {
	RepoPermQuerier
	accessTokenStore
	GetUserByIDNotDeleted(context.Context, int64) (db.User, error)
	GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	ConsumeSearchRateLimitToken(context.Context, db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error)
}

// GatewayPushTokenService exchanges the gateway operator credential for a
// short-lived PAT after rechecking the owner's repository write permission.
type GatewayPushTokenService struct {
	gateway interface {
		AuthorizeRelay(context.Context, string, string) (RepoGatewayRelayTarget, error)
	}
	q     GatewayPushTokenQuerier
	audit AdminAuditor
}

func NewGatewayPushTokenService(gateway *RepoGatewayService, q GatewayPushTokenQuerier, audit AdminAuditor) *GatewayPushTokenService {
	return &GatewayPushTokenService{gateway: gateway, q: q, audit: audit}
}

type GatewayPushTokenInput struct {
	Repo string `json:"repo"`
}

type GatewayPushTokenResult struct {
	Token        string    `json:"token"`
	TokenID      int64     `json:"token_id"`
	RepositoryID int64     `json:"repository_id"`
	Scopes       string    `json:"scopes"`
	ExpiresAt    time.Time `json:"expires_at"`
}

func (s *GatewayPushTokenService) Mint(ctx context.Context, gatewayID, bearer string, input GatewayPushTokenInput) (GatewayPushTokenResult, error) {
	refused := GatewayPushTokenResult{}
	target, err := s.gateway.AuthorizeRelay(ctx, gatewayID, bearer)
	if err != nil {
		return refused, err
	}
	// Use the database's canonical UUID, so alternate spellings of the route
	// parameter cannot create separate mint budgets for the same gateway.
	gatewayID = target.GatewayID
	if gatewayID == "" {
		return refused, pkgerrors.Internal("authenticated gateway identity unavailable")
	}
	owner, name, found := strings.Cut(strings.TrimSpace(input.Repo), "/")
	if !found || strings.TrimSpace(owner) == "" || strings.TrimSpace(name) == "" || strings.Contains(name, "/") {
		return refused, pkgerrors.BadRequest("repo must be owner/name")
	}
	repository, err := s.q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner: strings.ToLower(strings.TrimSpace(owner)), LowerName: strings.ToLower(strings.TrimSpace(name)),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return refused, pkgerrors.NotFound("repository not found")
	}
	if err != nil {
		return refused, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	if repository.ID <= 0 || repository.ID != target.RepositoryID {
		return refused, pkgerrors.Forbidden("gateway cannot mint credentials for another repository")
	}
	if repository.IsArchived {
		return refused, pkgerrors.Forbidden("cannot mint push credentials for an archived repository")
	}
	actor, err := s.q.GetUserByIDNotDeleted(ctx, target.UserID)
	if err != nil || !actor.IsActive || actor.ProhibitLogin {
		return refused, pkgerrors.Unauthorized("gateway user is unavailable")
	}
	allowed, err := canWriteRepo(ctx, s.q, repository, actor.ID)
	if err != nil {
		return refused, err
	}
	if !allowed {
		return refused, pkgerrors.Forbidden("repository write permission required")
	}

	// The existing atomic PostgreSQL bucket survives API restarts and is shared
	// across replicas. Authenticate first so strangers cannot drain a gateway's
	// budget. A failed issuance still consumes one attempt; store errors fail closed.
	const refillPerSecond = 3.0 / 60.0
	budget, err := s.q.ConsumeSearchRateLimitToken(ctx, db.ConsumeSearchRateLimitTokenParams{
		Scope: "gateway_push_token", PrincipalKey: "gateway:" + gatewayID,
		Capacity: 3, RefillPerSecond: refillPerSecond, NowAt: time.Now().UTC(),
	})
	if err != nil {
		return refused, pkgerrors.New(pkgerrors.CodeRateLimiterUnavailable, "gateway credential rate limiter unavailable")
	}
	if !budget.Allowed {
		limitErr := pkgerrors.New(pkgerrors.CodeRateLimitExceeded, "gateway push credential mint limit exceeded")
		limitErr.RetryAfter = max(1, int(math.Ceil((1-budget.RemainingTokens)/refillPerSecond)))
		return refused, limitErr
	}
	scopes := string(middleware.ScopeWriteRepository) + "," + middleware.RepositoryRestrictionScope(repository.ID)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, actor.ID, "sandbox-gateway-push-"+gatewayID, scopes, gatewayPushTokenTTL)
	if err != nil {
		return refused, pkgerrors.Internal("failed to mint gateway push credential").WithCause(err)
	}
	middleware.LoggerFromContext(ctx).Info("gateway push credential minted",
		"gateway_id", gatewayID, "user_id", actor.ID, "repository_id", repository.ID,
		"token_id", token.ID, "scopes", scopes, "expires_at", token.ExpiresAt)
	if s.audit != nil {
		s.audit.Log(ctx, AuditEvent{
			EventType: "token.create", ActorID: &actor.ID, ActorName: actor.Username,
			TargetType: "access_token", TargetID: &token.ID, TargetName: "sandbox-gateway-push-" + gatewayID,
			Action: "create", Metadata: map[string]any{
				"gateway_id": gatewayID, "repository_id": repository.ID, "scopes": scopes, "expires_at": token.ExpiresAt,
			},
		})
	}
	return GatewayPushTokenResult{Token: token.Plaintext, TokenID: token.ID,
		RepositoryID: repository.ID, Scopes: scopes, ExpiresAt: token.ExpiresAt}, nil
}
