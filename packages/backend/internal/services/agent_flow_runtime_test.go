package services

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAgentFlowHostTargetResolverReturnsServerOwnedCodingBinding(t *testing.T) {
	workspaceID := "11111111-1111-4111-8111-111111111111"
	parsedWorkspace := uuid.MustParse(workspaceID)
	agents := NewAgentService(&mockAgentQuerier{getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
		return db.AgentSession{ID: id, RepositoryID: 42, UserID: 7, Status: "active",
			WorkspaceID: pgtype.UUID{Bytes: parsedWorkspace, Valid: true}}, nil
	}})
	resolver, err := NewAgentFlowHostTargetResolver(agents)
	require.NoError(t, err)
	target := flowruntime.Target{TenantID: "repository:42", PrincipalID: "user:7",
		BindingKind: "agent-session", BindingID: "session-1"}
	authority, err := resolver.ResolveFlowHostTarget(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, target, authority.Target)
	require.Equal(t, int64(42), authority.RepositoryID)
	require.Equal(t, int64(7), authority.UserID)
	require.Equal(t, workspaceID, authority.WorkspaceID)
	require.Equal(t, flowhost.CatalogCoding, authority.CatalogKey)
}

func TestAgentFlowHostTargetResolverWaitsForDurableWorkspaceBinding(t *testing.T) {
	agents := NewAgentService(&mockAgentQuerier{getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
		return db.AgentSession{ID: id, RepositoryID: 42, UserID: 7, Status: "active"}, nil
	}})
	resolver, err := NewAgentFlowHostTargetResolver(agents)
	require.NoError(t, err)
	_, err = resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{
		TenantID: "repository:42", PrincipalID: "user:7", BindingKind: "agent-session", BindingID: "session-1",
	})
	var failure flowruntime.Failure
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "runtime_workspace_pending", failure.FlowRuntimeCode())
	require.True(t, failure.FlowRuntimeRetryable())
}

func TestAgentFlowHostTargetResolverRefusesCrossScopeBinding(t *testing.T) {
	agents := NewAgentService(&mockAgentQuerier{getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
		return db.AgentSession{ID: id, RepositoryID: 42, UserID: 7, Status: "active"}, nil
	}})
	resolver, err := NewAgentFlowHostTargetResolver(agents)
	require.NoError(t, err)
	_, err = resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{
		TenantID: "repository:99", PrincipalID: "user:7", BindingKind: "agent-session", BindingID: "session-1",
	})
	var failure flowruntime.Failure
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "runtime_target_forbidden", failure.FlowRuntimeCode())
	require.False(t, failure.FlowRuntimeRetryable())
}
