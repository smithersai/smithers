package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type agentDispatchZSandbox struct {
	deleteErr error
}

func (s agentDispatchZSandbox) CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
	return sandbox.CreateResult{ID: "vm-z"}, nil
}
func (s agentDispatchZSandbox) ForkSandbox(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
	return sandbox.CreateResult{}, nil
}
func (s agentDispatchZSandbox) CreateService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{Success: true}, nil
}
func (s agentDispatchZSandbox) InspectSandbox(context.Context, string) (sandbox.Sandbox, error) {
	return sandbox.Sandbox{}, nil
}
func (s agentDispatchZSandbox) DeleteSandbox(context.Context, string) error { return s.deleteErr }
func (s agentDispatchZSandbox) StartSandbox(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
	return sandbox.StartResult{}, nil
}
func (s agentDispatchZSandbox) SuspendSandbox(context.Context, string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{}, nil
}
func (s agentDispatchZSandbox) SnapshotSandbox(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	return sandbox.SnapshotResult{}, nil
}
func (s agentDispatchZSandbox) DeleteSnapshot(context.Context, string) error { return nil }
func (s agentDispatchZSandbox) CreateIdentity(context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{}, nil
}
func (s agentDispatchZSandbox) GrantAccess(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{}, nil
}
func (s agentDispatchZSandbox) CreateIdentityToken(context.Context, string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{}, nil
}

func TestAgentDispatch_Z_ErrorAndNoopBranches(t *testing.T) {
	ctx := context.Background()

	dispatch := &agentDispatch{
		svc:       &AgentService{sandbox: agentDispatchZSandbox{deleteErr: errors.New("delete failed")}},
		ctx:       ctx,
		vmCreated: true,
		vm:        sandbox.CreateResult{ID: "vm-z"},
	}
	dispatch.cleanup()

	oldRandRead := agentRandRead
	t.Cleanup(func() { agentRandRead = oldRandRead })
	agentRandRead = func([]byte) (int, error) { return 0, errors.New("entropy failed") }
	require.Error(t, (&agentDispatch{}).generateToken())
	agentRandRead = oldRandRead

	dispatch = &agentDispatch{
		svc: &AgentService{q: &mockAgentQuerier{
			listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
				return nil, nil
			},
		}},
		ctx: ctx,
		input: DispatchAgentRunInput{
			SessionID:     "session-z",
			RepositoryID:  101,
			AgentProvider: "codex",
		},
	}
	require.NoError(t, dispatch.loadMessageHistory())
	require.NotEmpty(t, dispatch.payload)

	oldListMessages := agentDispatchListMessages
	t.Cleanup(func() { agentDispatchListMessages = oldListMessages })
	agentDispatchListMessages = func(*AgentService, context.Context, string, int, int) ([]AgentMessageResponse, error) {
		return nil, nil
	}
	require.NoError(t, dispatch.loadMessageHistory())
	agentDispatchListMessages = oldListMessages

	oldMarshal := agentDispatchJSONMarshal
	t.Cleanup(func() { agentDispatchJSONMarshal = oldMarshal })
	agentDispatchJSONMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal failed") }
	require.Error(t, dispatch.loadMessageHistory())
	agentDispatchJSONMarshal = oldMarshal

	dispatch = &agentDispatch{svc: &AgentService{}, ctx: ctx, input: DispatchAgentRunInput{}}
	require.NoError(t, dispatch.prepareRepoClone())

	dispatch.input.RepoOwner = "alice"
	dispatch.input.RepoName = "demo"
	require.Error(t, dispatch.prepareRepoClone())
	require.True(t, dispatch.infraFailedMarked)
}
