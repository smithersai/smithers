package services

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

// AgentFlowHostTargetResolver is the shared authority half of host resolution.
// Both the trusted owner runtime and Plue's isolated adapter consume this same
// mapping before flowhost acquires the durable host binding and starts/probes
// the canonical TypeScript host.
type AgentFlowHostTargetResolver struct {
	agents *AgentService
}

func NewAgentFlowHostTargetResolver(agents *AgentService) (*AgentFlowHostTargetResolver, error) {
	if agents == nil || agents.q == nil {
		return nil, errors.New("agent Flow host target resolver requires the agent store")
	}
	return &AgentFlowHostTargetResolver{agents: agents}, nil
}

func (resolver *AgentFlowHostTargetResolver) ResolveFlowHostTarget(
	ctx context.Context,
	target flowruntime.FlowRuntimeTarget,
) (flowhost.Authority, error) {
	if resolver == nil || resolver.agents == nil || resolver.agents.q == nil {
		return flowhost.Authority{}, agentFlowRuntimeFailure{code: "runtime_resolver_unavailable", retryable: true}
	}
	_, repositoryID, userID, workspaceID, err := resolveAgentFlowTarget(ctx, resolver.agents, target)
	if err != nil {
		return flowhost.Authority{}, err
	}
	return flowhost.Authority{
		Target: target, RepositoryID: repositoryID, UserID: userID, WorkspaceID: workspaceID,
		CatalogKey: flowhost.CatalogCoding,
		// Coding hosts do not need an owner/name string; the repository id and
		// workspace binding above are their complete common authority.
		Repository: "",
	}, nil
}

func resolveAgentFlowTarget(
	ctx context.Context,
	agents *AgentService,
	target flowruntime.FlowRuntimeTarget,
) (sessionID string, repositoryID, userID int64, workspaceID string, failureErr error) {
	if target.BindingKind != "agent-session" || strings.TrimSpace(target.BindingID) == "" {
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_target_unsupported"}
	}
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	if !repositoryOK || !userOK {
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_target_invalid"}
	}
	session, err := agents.q.GetAgentSession(ctx, target.BindingID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_target_not_found"}
		}
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	if session.ID != target.BindingID || session.RepositoryID != repositoryID || session.UserID != userID || session.DeletedAt.Valid {
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_target_forbidden"}
	}
	workspaceID = UUIDString(session.WorkspaceID)
	if workspaceID == "" {
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_workspace_pending", retryable: true}
	}
	if target.WorkspaceID != "" && target.WorkspaceID != workspaceID {
		return "", 0, 0, "", agentFlowRuntimeFailure{code: "runtime_workspace_replaced"}
	}
	return session.ID, repositoryID, userID, workspaceID, nil
}

type agentFlowRuntimeFailure struct {
	code      string
	retryable bool
}

func (failure agentFlowRuntimeFailure) Error() string              { return "agent Flow runtime: " + failure.code }
func (failure agentFlowRuntimeFailure) FlowRuntimeCode() string    { return failure.code }
func (failure agentFlowRuntimeFailure) FlowRuntimeRetryable() bool { return failure.retryable }

func scopedFlowRuntimeID(value, prefix string) (int64, bool) {
	raw, ok := strings.CutPrefix(value, prefix)
	if !ok || raw == "" || strings.TrimSpace(raw) != raw {
		return 0, false
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	return parsed, err == nil && parsed > 0 && strconv.FormatInt(parsed, 10) == raw
}

var _ flowhost.TargetResolver = (*AgentFlowHostTargetResolver)(nil)
var _ flowruntime.FlowRuntimeFailure = agentFlowRuntimeFailure{}
