package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordingCodingGateway answers the three procedures one dispatched turn
// drives, and records what it was asked for.
type recordingCodingGateway struct {
	calls        []string
	capabilities []string
	inputs       []json.RawMessage
	approvals    []json.RawMessage
	runID        string
	planID       string
}

func (g *recordingCodingGateway) CallRepositoryJob(_ context.Context, input RepoGatewayConnectionInput, capability string, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	g.calls = append(g.calls, procedure)
	g.capabilities = append(g.capabilities, capability)
	if input.WorkspaceID == "" {
		return nil, assertWorkspaceRequired
	}
	switch procedure {
	case "Plan":
		var request struct {
			FlowID string          `json:"flowId"`
			Input  json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		g.inputs = append(g.inputs, request.Input)
		return json.RawMessage(`{"planId":"` + g.planID + `","flowId":"` + request.FlowID +
			`","digest":"sha256:plan","executionDigest":"sha256:exec","envelope":{"flows":["coding/RunDispatch"]},` +
			`"approval":{"target":{"_tag":"Plan","planId":"` + g.planID + `"},"decision":"pending"}}`), nil
	case "Approval.Submit":
		g.approvals = append(g.approvals, payload)
		return json.RawMessage(`{"_tag":"Recorded"}`), nil
	case "Run":
		return json.RawMessage(`{"_tag":"Accepted","runId":"` + g.runID + `"}`), nil
	}
	return nil, assertUnexpectedProcedure
}

var (
	assertWorkspaceRequired   = &RepositoryJobRPCError{Tag: "WorkspaceRequired"}
	assertUnexpectedProcedure = &RepositoryJobRPCError{Tag: "UnexpectedProcedure"}
)

func TestWorkspaceGatewayMountKeepsAnAllowlist(t *testing.T) {
	for procedure, mount := range map[string]string{
		"Plan": "/rpc", "Run": "/rpc", "Signal": "/rpc", "List": "/rpc",
		"Approval.Submit": "/projections", "Projection.Snapshot": "/projections",
	} {
		got, allowed := workspaceGatewayMount(procedure)
		assert.True(t, allowed, procedure)
		assert.Equal(t, mount, got, procedure)
	}
	// Naming the capability widened who may call, never what may be called.
	for _, procedure := range []string{"", "Cancel", "Projection.Subscribe", "plan", "Approval"} {
		_, allowed := workspaceGatewayMount(procedure)
		assert.False(t, allowed, procedure)
	}
}

func TestCodingTurnRequestSplitsTheWindowFromThePrompt(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Where does the greeting live?"},
		{Role: "assistant", Content: "In greeting.mjs."},
		{Role: "assistant", Content: "   "},
		{Role: "user", Content: "Explain what it exports."},
	}})
	require.NoError(t, err)
	d := &agentDispatch{payload: payload}
	d.run.ID = 77

	turn, err := d.codingTurnRequest()
	require.NoError(t, err)
	assert.Equal(t, "Explain what it exports.", turn.Prompt)
	assert.Equal(t, "run-77", turn.TurnID)
	assert.Equal(t, codingDispatchRole, turn.Role)
	// The role travels with the request; the host's launch environment is
	// never consulted for it, and no model is forced on the workspace.
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
	d := &agentDispatch{payload: payload}
	_, err = d.codingTurnRequest()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "user message")
}

func TestDispatchCodingTurnDrivesTheGatewayAndRecordsTheHostRun(t *testing.T) {
	gateway := &recordingCodingGateway{planID: "plan-1", runID: "host-run-1"}
	querier := &mockAgentDispatchQuerier{}
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Explain what greeting.mjs exports."},
	}})
	require.NoError(t, err)
	d := &agentDispatch{
		svc:         &AgentService{codingGateway: gateway, dispatchQ: querier, workspaces: nil},
		ctx:         context.Background(),
		input:       DispatchAgentRunInput{SessionID: "session-1", RepositoryID: 5, UserID: 9, RepoOwner: "org", RepoName: "repo"},
		payload:     payload,
		workspaceID: "11111111-1111-4111-8111-111111111111",
	}
	d.run.ID = 42

	require.NoError(t, d.dispatchCodingTurn())

	// Exactly the three procedures, in order, all under the door's own
	// capability rather than the repository-jobs one.
	assert.Equal(t, []string{"Plan", "Approval.Submit", "Run"}, gateway.calls)
	for _, capability := range gateway.capabilities {
		assert.Equal(t, codingDispatchCapability, capability)
	}
	// The approval submitted is the host's own plan card, decided.
	require.Len(t, gateway.approvals, 1)
	var approval map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(gateway.approvals[0], &approval))
	assert.JSONEq(t, `"approve"`, string(approval["decision"]))
	assert.Contains(t, string(approval["target"]), "plan-1")

	// The flow input is the dispatched turn, bound to the workspace the
	// gateway serves.
	require.Len(t, gateway.inputs, 1)
	var turn codingTurnInput
	require.NoError(t, json.Unmarshal(gateway.inputs[0], &turn))
	assert.Equal(t, "Explain what greeting.mjs exports.", turn.Prompt)
	assert.Equal(t, defaultWorkspaceClonePath, turn.WorkspaceRoot)

	// Durable before anything streams it.
	assert.Equal(t, "host-run-1", querier.codingHost.HostRunID)
	assert.Equal(t, int64(42), querier.codingHost.WorkflowRunID)
	assert.Equal(t, codingDispatchFlowID, querier.codingHost.FlowID)
	host, err := querier.GetWorkflowRunCodingHost(context.Background(), 42)
	require.NoError(t, err)
	assert.Equal(t, "host-run-1", host.HostRunID)
}

func TestCodingDispatchEnabledNeedsBothAGatewayAndAWorkspace(t *testing.T) {
	gateway := &recordingCodingGateway{}
	// No gateway wired: production's state, and the typed refusal still holds.
	owned := DispatchAgentRunInput{RepoOwner: "org", RepoName: "repo"}
	unwired := &agentDispatch{svc: &AgentService{workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.False(t, unwired.codingDispatchEnabled())
	assert.False(t, unwired.svc.guestEntrypointAssumed)

	// Wired, but the run has no workspace to host the turn.
	ephemeral := &agentDispatch{svc: &AgentService{codingGateway: gateway}, input: owned}
	assert.False(t, ephemeral.codingDispatchEnabled())

	wired := &agentDispatch{svc: &AgentService{codingGateway: gateway, workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.True(t, wired.codingDispatchEnabled())
}

// stubAgentWorkspaceBackend only has to exist: workspaceMode() asks whether a
// backend is wired, never what it does.
type stubAgentWorkspaceBackend struct{}

func (stubAgentWorkspaceBackend) CreateAgentWorkspace(context.Context, CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
	return AgentWorkspaceResult{}, nil
}
func (stubAgentWorkspaceBackend) SuspendAgentWorkspace(context.Context, string) error { return nil }
func (stubAgentWorkspaceBackend) FailAgentWorkspace(context.Context, string) error    { return nil }
func (stubAgentWorkspaceBackend) SnapshotAgentWorkspace(context.Context, string, string) (string, error) {
	return "", nil
}
