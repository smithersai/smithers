package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	codingDispatchFlowID = "coding/dispatch"
	codingDispatchRole   = "coding/dispatch"
)

// AgentFlowDispatcher is the durable product boundary used by agent runs. Its
// implementation is flowdispatch.Service in both single-owner and Plue
// composition; runtime selection stays behind flowruntime.FlowRuntimeResolver.
type AgentFlowDispatcher interface {
	Admit(context.Context, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
	CancelRequest(context.Context, jobs.Scope, string) (jobs.Operation, error)
}

func WithAgentFlowDispatcher(dispatcher AgentFlowDispatcher) AgentServiceOption {
	return func(service *AgentService) { service.flowDispatcher = dispatcher }
}

// SetFlowDispatcher completes the intentional construction cycle: the agent
// service is the product projector supplied to flowdispatch, then receives the
// constructed dispatcher. App composition owns the call.
func (service *AgentService) SetFlowDispatcher(dispatcher AgentFlowDispatcher) {
	if service != nil {
		service.flowDispatcher = dispatcher
	}
}

func (dispatch *agentDispatch) codingDispatchEnabled() bool {
	return dispatch.svc != nil && dispatch.svc.flowDispatcher != nil && dispatch.workspaceMode()
}

type codingTurnMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type codingTurnInput struct {
	TurnID  string              `json:"turnId"`
	Prompt  string              `json:"prompt"`
	History []codingTurnMessage `json:"history"`
	Role    string              `json:"role"`
	Model   string              `json:"model,omitempty"`
}

type agentFlowProjection struct {
	Kind           string `json:"kind"`
	SessionID      string `json:"sessionId"`
	WorkflowRunID  int64  `json:"workflowRunId"`
	WorkflowTaskID int64  `json:"workflowTaskId"`
}

func (dispatch *agentDispatch) codingTurnRequest() (codingTurnInput, error) {
	var payload agentTaskPayload
	if err := json.Unmarshal(dispatch.payload, &payload); err != nil {
		return codingTurnInput{}, fmt.Errorf("read dispatched turn history: %w", err)
	}
	history := make([]codingTurnMessage, 0, len(payload.MessageHistory))
	prompt := ""
	for index, message := range payload.MessageHistory {
		if index == len(payload.MessageHistory)-1 && message.Role == "user" {
			prompt = message.Content
			break
		}
		if strings.TrimSpace(message.Content) == "" {
			continue
		}
		history = append(history, codingTurnMessage{Role: message.Role, Content: message.Content})
	}
	if strings.TrimSpace(prompt) == "" {
		return codingTurnInput{}, errors.New("a dispatched turn needs a user message to answer")
	}
	return codingTurnInput{
		TurnID:  fmt.Sprintf("run-%d", dispatch.run.ID),
		Prompt:  prompt,
		History: history,
		Role:    codingDispatchRole,
	}, nil
}

func agentFlowScope(repositoryID, userID int64) jobs.Scope {
	return jobs.Scope{
		TenantID:    "repository:" + strconv.FormatInt(repositoryID, 10),
		PrincipalID: "user:" + strconv.FormatInt(userID, 10),
	}
}

func agentFlowRequestID(workflowRunID int64) string {
	return "agent-run:" + strconv.FormatInt(workflowRunID, 10)
}

// admitCodingTurn commits the durable product request before repository
// preparation, credential delivery, workspace provisioning, or any runtime
// network request. The shared jobs worker resolves the workspace host later.
func (dispatch *agentDispatch) admitCodingTurn() error {
	if !dispatch.codingDispatchEnabled() {
		return nil
	}
	turn, err := dispatch.codingTurnRequest()
	if err != nil {
		return dispatch.markInfraFailed("build dispatched turn: " + err.Error())
	}
	payload, err := json.Marshal(turn)
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn: " + err.Error())
	}
	projection, err := json.Marshal(agentFlowProjection{
		Kind: "agent-workflow-run", SessionID: dispatch.input.SessionID,
		WorkflowRunID: dispatch.run.ID, WorkflowTaskID: dispatch.task.ID,
	})
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn projection: " + err.Error())
	}
	authorization, err := json.Marshal(map[string]any{
		"repositoryId": dispatch.input.RepositoryID,
		"userId":       dispatch.input.UserID,
		"sessionId":    dispatch.input.SessionID,
	})
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn authorization: " + err.Error())
	}
	receipt, err := dispatch.svc.flowDispatcher.Admit(dispatch.ctx, flowdispatch.LaunchRequest{
		Scope:     agentFlowScope(dispatch.input.RepositoryID, dispatch.input.UserID),
		RequestID: agentFlowRequestID(dispatch.run.ID),
		Target: flowruntime.FlowRuntimeTarget{
			BindingKind: "agent-session", BindingID: dispatch.input.SessionID,
		},
		FlowID: codingDispatchFlowID, Payload: payload,
		AuthorizationContext: authorization, Projection: projection,
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	if err != nil {
		return dispatch.markInfraFailed("admit dispatched turn: " + err.Error())
	}
	dispatch.flowOperationID = receipt.OperationID
	return nil
}

func (dispatch *agentDispatch) cancelCodingTurn(ctx context.Context) {
	if dispatch.svc == nil || dispatch.svc.flowDispatcher == nil || dispatch.run.ID == 0 {
		return
	}
	_, _ = dispatch.svc.flowDispatcher.CancelRequest(
		ctx,
		agentFlowScope(dispatch.input.RepositoryID, dispatch.input.UserID),
		agentFlowRequestID(dispatch.run.ID),
	)
}

// ProjectFlowRuntime keeps legacy workflow/session rows as idempotent product
// projections. It never reads or constructs Flow graph state, and it leaves
// assistant/model frames to the issue08 durable turn journal.
func (service *AgentService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	if service == nil || service.dispatchQ == nil {
		return errors.New("agent Flow projection store unavailable")
	}
	var projection agentFlowProjection
	if err := json.Unmarshal(update.Checkpoint.Projection, &projection); err != nil {
		return fmt.Errorf("decode agent Flow projection: %w", err)
	}
	if projection.Kind != "agent-workflow-run" {
		return nil
	}
	if projection.SessionID == "" || projection.WorkflowRunID <= 0 || projection.WorkflowTaskID <= 0 {
		return errors.New("agent Flow projection identity is invalid")
	}
	if update.Checkpoint.RunID != "" {
		workspaceID := service.agentSessionWorkspaceID(ctx, projection.SessionID)
		if workspaceID == "" {
			return errors.New("agent workspace is not ready for Flow receipt projection")
		}
		if _, err := service.dispatchQ.RecordWorkflowRunCodingHost(ctx, clusterdb.RecordWorkflowRunCodingHostParams{
			WorkflowRunID: projection.WorkflowRunID,
			WorkspaceID:   workspaceID,
			HostRunID:     update.Checkpoint.RunID,
			FlowID:        update.Checkpoint.FlowID,
		}); err != nil {
			return fmt.Errorf("record canonical Flow run receipt: %w", err)
		}
	}
	if !update.State.Terminal() {
		return nil
	}
	finalStatus := "failed"
	lastError := "the canonical Flow run failed"
	switch update.State {
	case jobs.StateCompleted:
		finalStatus, lastError = "completed", ""
	case jobs.StateCancelled:
		finalStatus, lastError = "cancelled", "the canonical Flow run was cancelled"
	}
	session, transitioned, err := service.transitionAgentSessionTerminalStatus(ctx, projection.SessionID, finalStatus)
	if err != nil {
		return fmt.Errorf("project canonical Flow terminal status: %w", err)
	}
	if transitioned {
		service.finalizeAgentSession(ctx, session, finalStatus, lastError)
	}
	return nil
}

var _ flowdispatch.Projector = (*AgentService)(nil)
