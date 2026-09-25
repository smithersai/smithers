package services

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	// ProviderPoolPath is where guests reach the account pool: outside /api,
	// because a model call streams for minutes and workspace-bound
	// credentials are confined away from the /api surface.
	ProviderPoolPath = "/provider-pool"
	// ProviderPoolURLEnvName names the pool origin for the guest's model
	// routes (NativeEquipment): ${SMITHERS_ACCOUNT_POOL_URL}/{anthropic,chatgpt}.
	ProviderPoolURLEnvName = "SMITHERS_ACCOUNT_POOL_URL"
	// ProviderPoolProvidersEnvName lists the pooled routes ("anthropic",
	// "chatgpt"), so a provider without connected accounts keeps its own
	// credential and origin.
	ProviderPoolProvidersEnvName = "SMITHERS_ACCOUNT_POOL_PROVIDERS"

	providerPoolTokenPrefix = "provider-pool-workspace-"
	providerPoolTokenTTL    = 7 * 24 * time.Hour
)

// providerPoolSeats are the guest seats a pool serves: the Anthropic seat
// for Claude accounts, the OpenAI seat in ChatGPT mode for Codex accounts.
var providerPoolSeats = []struct{ seat, provider, route string }{
	{"ANTHROPIC_API_KEY", ProviderConnectionProviderClaude, "anthropic"},
	{"OPENAI_API_KEY", ProviderConnectionProviderCodex, "chatgpt"},
}

// ProviderPoolTokenScopes binds a pool credential to one repository and one
// workspace. It grants read:workspace only; the pool route checks the
// bindings against the workspace row.
func ProviderPoolTokenScopes(repositoryID int64, workspaceID string) string {
	return string(middleware.ScopeReadWorkspace) + "," +
		middleware.RepositoryRestrictionScope(repositoryID) + "," +
		middleware.WorkspaceRestrictionScope(workspaceID)
}

type providerPoolTokenLister interface {
	ListAccessTokensByUserID(ctx context.Context, userID int64) ([]db.AccessToken, error)
}

// bindWorkspaceProviderPool offers the pool for each provider with connected
// accounts. The pool credential is minted once per boot, replacing the
// workspace's earlier one; the seats carry it as their placeholder value on
// the API host only, so no provider token is ever bound or visible.
func (s *WorkspaceService) bindWorkspaceProviderPool(ctx context.Context, workspace db.Workspace, binding *workspaceProviderBinding) error {
	if workspace.RepositoryID <= 0 || workspace.UserID <= 0 {
		return nil
	}
	base := normalizePublicBaseURL(s.gitBaseURL)
	host := apiHost(base)
	if !sandbox.ValidEgressHost(host) {
		return nil
	}
	var seats, routes []string
	chatgpt := false
	for _, pool := range providerPoolSeats {
		if workspaceDeclaresProvider(binding.environment, pool.seat) {
			continue
		}
		has, err := s.providerConnections.HasPool(ctx, workspace.UserID, workspace.RepositoryID, pool.provider)
		if err != nil {
			return pkgerrors.Internal("resolve workspace provider accounts").WithCause(err)
		}
		if has {
			seats = append(seats, pool.seat)
			routes = append(routes, pool.route)
			chatgpt = chatgpt || pool.provider == ProviderConnectionProviderCodex
		}
	}
	if len(seats) == 0 {
		return nil
	}
	s.revokeProviderPoolTokens(ctx, workspace)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, workspace.UserID, providerPoolTokenPrefix+workspace.ID,
		ProviderPoolTokenScopes(workspace.RepositoryID, workspace.ID), providerPoolTokenTTL)
	if err != nil {
		return pkgerrors.Internal("mint workspace provider pool credential").WithCause(err)
	}
	for _, seat := range seats {
		binding.bind(sandbox.EgressProxySecret{Name: seat, Value: token.Plaintext, Hosts: []string{host}, MatchHeaders: []string{"authorization", "x-api-key"}})
	}
	binding.setEnv(ProviderPoolURLEnvName, strings.TrimRight(base, "/")+ProviderPoolPath)
	binding.setEnv(ProviderPoolProvidersEnvName, strings.Join(routes, ","))
	if chatgpt {
		binding.setEnv("SMITHERS_OPENAI_AUTH", "chatgpt")
	}
	return nil
}

func (s *WorkspaceService) revokeProviderPoolTokens(ctx context.Context, workspace db.Workspace) {
	lister, ok := s.q.(providerPoolTokenLister)
	if !ok {
		return
	}
	tokens, err := lister.ListAccessTokensByUserID(ctx, workspace.UserID)
	if err != nil {
		slog.Warn("list provider pool credentials failed", "workspace_id", workspace.ID, "error", err)
		return
	}
	for _, token := range tokens {
		if token.Name == providerPoolTokenPrefix+workspace.ID {
			revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, token.ID)
		}
	}
}

// providerPoolScopeQuerier resolves the credential and the workspace it names.
type providerPoolScopeQuerier interface {
	GetAccessTokenByID(ctx context.Context, id int64) (db.AccessToken, error)
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// ProviderPoolScopes binds a pool call to the workspace's repository.
type ProviderPoolScopes struct {
	q providerPoolScopeQuerier
}

func NewProviderPoolScopes(q providerPoolScopeQuerier) *ProviderPoolScopes {
	return &ProviderPoolScopes{q: q}
}

// Scope answers the pool (user, repository) of an authenticated call: the
// token must be the workspace's platform-minted pool credential (not another
// workspace-bound token, such as the head reporter's), bound to that
// workspace and its repository, and the workspace must belong to its user.
func (p *ProviderPoolScopes) Scope(ctx context.Context, info *middleware.AuthInfo) (userID, repositoryID int64, ok bool) {
	if p == nil || info == nil || !info.IsTokenAuth || info.User == nil {
		return 0, 0, false
	}
	workspaceID := info.WorkspaceRestriction()
	repositoryID = info.RepositoryRestriction()
	if workspaceID == "" || repositoryID <= 0 {
		return 0, 0, false
	}
	token, err := p.q.GetAccessTokenByID(ctx, info.TokenID)
	if err != nil || !token.SystemIssued || token.UserID != info.User.ID || token.Name != providerPoolTokenPrefix+workspaceID {
		return 0, 0, false
	}
	workspace, err := p.q.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.UserID != info.User.ID || workspace.RepositoryID != repositoryID {
		return 0, 0, false
	}
	return workspace.UserID, repositoryID, true
}
