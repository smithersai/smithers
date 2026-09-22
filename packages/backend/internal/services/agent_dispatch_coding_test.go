package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type recordingAgentFlowDispatcher struct {
	launches []flowdispatch.LaunchRequest
	cancels  []struct {
		scope     jobs.Scope
		requestID string
	}
}

func (dispatcher *recordingAgentFlowDispatcher) Admit(_ context.Context, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	dispatcher.launches = append(dispatcher.launches, request)
	return jobs.RequestReceipt{OperationID: "operation-1", RequestID: request.RequestID, State: jobs.StateAccepted}, nil
}

func (dispatcher *recordingAgentFlowDispatcher) CancelRequest(_ context.Context, scope jobs.Scope, requestID string) (jobs.Operation, error) {
	dispatcher.cancels = append(dispatcher.cancels, struct {
		scope     jobs.Scope
		requestID string
	}{scope: scope, requestID: requestID})
	return jobs.Operation{ID: "operation-1", Scope: scope, State: jobs.StateWaiting}, nil
}

func TestCodingTurnRequestSplitsTheWindowFromThePrompt(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Where does the greeting live?"},
		{Role: "assistant", Content: "In greeting.mjs."},
		{Role: "assistant", Content: "   "},
		{Role: "user", Content: "Explain what it exports."},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{payload: payload}
	dispatch.run.ID = 77

	turn, err := dispatch.codingTurnRequest()
	require.NoError(t, err)
	assert.Equal(t, "Explain what it exports.", turn.Prompt)
	assert.Equal(t, "run-77", turn.TurnID)
	assert.Equal(t, codingDispatchRole, turn.Role)
	assert.Empty(t, turn.Model)
	assert.Equal(t, defaultWorkspaceClonePath, turn.WorkspaceRoot)
	assert.Equal(t, []codingTurnMessage{
		{Role: "user", Content: "Where does the greeting live?"},
		{Role: "assistant", Content: "In greeting.mjs."},
	}, turn.History)
}

func TestCodingTurnRequestRefusesAWindowWithNothingToAnswer(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "assistant", Content: "Anything else?"},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{payload: payload}
	_, err = dispatch.codingTurnRequest()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "user message")
}

func TestAdmitCodingTurnPersistsCanonicalFlowRequestWithoutRuntimeCall(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Explain what greeting.mjs exports."},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{
		svc: &AgentService{
			flowDispatcher: dispatcher,
			workspaces:     stubAgentWorkspaceBackend{},
		},
		ctx: context.Background(),
		input: DispatchAgentRunInput{
			SessionID: "session-1", RepositoryID: 5, UserID: 9,
			RepoOwner: "org", RepoName: "repo",
		},
		payload: payload,
	}
	dispatch.run.ID = 42
	dispatch.task.ID = 43

	require.NoError(t, dispatch.admitCodingTurn())
	require.Len(t, dispatcher.launches, 1)
	launch := dispatcher.launches[0]
	assert.Equal(t, codingDispatchFlowID, launch.FlowID)
	assert.Equal(t, "agent-run:42", launch.RequestID)
	assert.Equal(t, jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, launch.Scope)
	assert.Equal(t, "agent-session", launch.Target.BindingKind)
	assert.Equal(t, "session-1", launch.Target.BindingID)
	assert.Equal(t, flowdispatch.ApprovalAuto, launch.ApprovalPolicy)
	assert.Equal(t, "operation-1", dispatch.flowOperationID)

	var turn codingTurnInput
	require.NoError(t, json.Unmarshal(launch.Payload, &turn))
	assert.Equal(t, "Explain what greeting.mjs exports.", turn.Prompt)
	var projection agentFlowProjection
	require.NoError(t, json.Unmarshal(launch.Projection, &projection))
	assert.Equal(t, agentFlowProjection{
		Kind: "agent-workflow-run", SessionID: "session-1", WorkflowRunID: 42, WorkflowTaskID: 43,
	}, projection)
}

func TestCodingDispatchEnabledNeedsDispatcherAndWorkspace(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	owned := DispatchAgentRunInput{RepoOwner: "org", RepoName: "repo"}
	unwired := &agentDispatch{svc: &AgentService{workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.False(t, unwired.codingDispatchEnabled())
	assert.False(t, unwired.svc.guestEntrypointAssumed)

	ephemeral := &agentDispatch{svc: &AgentService{flowDispatcher: dispatcher}, input: owned}
	assert.False(t, ephemeral.codingDispatchEnabled())

	wired := &agentDispatch{svc: &AgentService{flowDispatcher: dispatcher, workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.True(t, wired.codingDispatchEnabled())
}

func TestCleanupCancellationReconnectsByStableProductRequest(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	dispatch := &agentDispatch{
		svc:   &AgentService{flowDispatcher: dispatcher},
		input: DispatchAgentRunInput{RepositoryID: 5, UserID: 9},
	}
	dispatch.run.ID = 42
	dispatch.cancelCodingTurn(context.Background())
	require.Len(t, dispatcher.cancels, 1)
	assert.Equal(t, jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, dispatcher.cancels[0].scope)
	assert.Equal(t, "agent-run:42", dispatcher.cancels[0].requestID)
}

type stubAgentWorkspaceBackend struct{}

func (stubAgentWorkspaceBackend) CreateAgentWorkspace(context.Context, CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
	return AgentWorkspaceResult{}, nil
}
func (stubAgentWorkspaceBackend) SuspendAgentWorkspace(context.Context, string) error { return nil }
func (stubAgentWorkspaceBackend) FailAgentWorkspace(context.Context, string) error    { return nil }
func (stubAgentWorkspaceBackend) SnapshotAgentWorkspace(context.Context, string, string) (string, error) {
	return "", nil
}
