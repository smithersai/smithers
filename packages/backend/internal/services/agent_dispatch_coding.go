package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The dispatched-turn door on the workspace coding host.
//
// `smithers-coding-host serve` advertises coding-dispatch/v1 and registers
// `coding/dispatch` unconditionally — unlike `coding/request`, which exists
// only when the host was launched with a project JSON. One turn in, the
// assistant messages it produced out, plus the host run id every gateway
// projection selector takes.
const (
	codingDispatchCapability = "coding-dispatch/v1"
	codingDispatchFlowID     = "coding/dispatch"
	// The seat role a dispatched turn runs as. The host's role table maps it
	// onto the workspace's configured implementation model; a request may
	// name an explicit provider:model instead, which is why the flow takes
	// both and neither is read from the host's launch environment.
	codingDispatchRole = "coding/dispatch"
	// How long one dispatched turn may run before the poller gives up on it.
	// The turn keeps running in the workspace; plue stops waiting.
	codingDispatchDeadline = 30 * time.Minute
	// How often the poller asks the host how the turn is going.
	codingDispatchPollInterval = 2 * time.Second
)

// AgentCodingGateway is the workspace-gateway surface a dispatched turn needs.
// It is the same method the repository job worker drives, named here so the
// agent service depends on the call rather than on the whole gateway service.
type AgentCodingGateway interface {
	CallRepositoryJob(ctx context.Context, input RepoGatewayConnectionInput, capability string, procedure string, payload json.RawMessage) (json.RawMessage, error)
}

// WithAgentCodingGateway enables dispatched turns over the workspace coding
// host. While it is unset every dispatch still refuses with the typed 501:
// this is the flag that turns the new path on, deployment by deployment,
// until the pinned host bundle is re-baked and the path is proven against a
// real guest.
func WithAgentCodingGateway(gateway AgentCodingGateway) AgentServiceOption {
	return func(s *AgentService) { s.codingGateway = gateway }
}

// codingDispatchEnabled reports whether THIS dispatch runs its turn on the
// workspace coding host. It needs a wired gateway and a workspace: the host
// is the workspace's own long-lived process, and the ephemeral-VM path has
// no workspace for it to live in.
func (d *agentDispatch) codingDispatchEnabled() bool {
	return d.svc != nil && d.svc.codingGateway != nil && d.workspaceMode()
}

// codingDispatchPlan is the plan card the host answers a Plan with. Same
// shape the repository job worker validates, because it is the same control
// plane answering.
type codingDispatchPlan struct {
	PlanID          string          `json:"planId"`
	FlowID          string          `json:"flowId"`
	Digest          string          `json:"digest"`
	ExecutionDigest string          `json:"executionDigest"`
	Envelope        json.RawMessage `json:"envelope"`
	Approval        json.RawMessage `json:"approval"`
}

// codingDispatchRunReceipt is what Run answers with.
type codingDispatchRunReceipt struct {
	Tag   string `json:"_tag"`
	RunID string `json:"runId"`
}

// codingTurnMessage is one line of the caller's bounded session window, in
// the shape the flow's DispatchInput declares.
type codingTurnMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// codingTurnInput is the flow's DispatchInput.
type codingTurnInput struct {
	TurnID        string              `json:"turnId"`
	Prompt        string              `json:"prompt"`
	History       []codingTurnMessage `json:"history"`
	Role          string              `json:"role"`
	Model         string              `json:"model,omitempty"`
	WorkspaceRoot string              `json:"workspaceRoot"`
}

// codingTurnResult is the flow's DispatchResult.
type codingTurnResult struct {
	TurnID   string `json:"turnId"`
	RunID    string `json:"runId"`
	Seat     string `json:"seat"`
	Messages []struct {
		Ordinal int64  `json:"ordinal"`
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

// codingConnection is the workspace binding every call in this turn uses.
// The capability is checked against the host's advertised list on each call,
// so a workspace whose host predates the dispatch door is refused with the
// existing upgrade-required error rather than hanging.
func (d *agentDispatch) codingConnection() RepoGatewayConnectionInput {
	return RepoGatewayConnectionInput{
		RepositoryID:        d.input.RepositoryID,
		UserID:              d.input.UserID,
		RepoOwner:           d.input.RepoOwner,
		RepoName:            d.input.RepoName,
		RepoDefaultBookmark: d.input.SourceBookmark,
		WorkspaceID:         d.workspaceID,
	}
}

// codingTurnRequest builds the one turn this dispatch runs.
//
// The window is the history already loaded for the task payload — the same
// 200 messages, in the same order — and the trigger message is the prompt.
// Nothing is read from the host's environment: the role travels with the
// request so a workspace can serve several seats, and the caller's provider
// choice becomes the explicit model when it names one.
func (d *agentDispatch) codingTurnRequest() (codingTurnInput, error) {
	var payload agentTaskPayload
	if err := json.Unmarshal(d.payload, &payload); err != nil {
		return codingTurnInput{}, fmt.Errorf("read dispatched turn history: %w", err)
	}
	history := make([]codingTurnMessage, 0, len(payload.MessageHistory))
	prompt := ""
	for index, message := range payload.MessageHistory {
		// The last user message is what this turn answers; everything before
		// it is the window. A history whose final line is not the trigger
		// still dispatches: the window is then complete and the prompt is
		// the newest user line it holds.
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
		TurnID:        fmt.Sprintf("run-%d", d.run.ID),
		Prompt:        prompt,
		History:       history,
		Role:          codingDispatchRole,
		WorkspaceRoot: defaultWorkspaceClonePath,
	}, nil
}

// call drives one gateway procedure for this turn.
func (d *agentDispatch) callCoding(procedure string, body any) (json.RawMessage, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return d.svc.codingGateway.CallRepositoryJob(d.ctx, d.codingConnection(), codingDispatchCapability, procedure, payload)
}

// dispatchCodingTurn starts one turn on the workspace's already-running
// coding host and records the host run id.
//
// It never launches a second host. `workspaceGatewayCommand` holds a
// non-blocking flock on /run/smithers-workspace-coding/<workspace>.lock with
// --conflict-exit-code 75, so a second `serve` in the same workspace would
// spin against a held lock forever; the gateway service resolves the existing
// healthy process instead, and this call rides it.
func (d *agentDispatch) dispatchCodingTurn() error {
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID)
	turn, err := d.codingTurnRequest()
	if err != nil {
		return d.markInfraFailed("build dispatched turn: " + err.Error())
	}
	key := fmt.Sprintf("agent-turn:%d", d.run.ID)

	planned, err := d.callCoding("Plan", map[string]any{
		"flowId": codingDispatchFlowID, "input": turn, "idempotencyKey": key + ":plan",
	})
	if err != nil {
		return d.markInfraFailed("plan dispatched turn: " + err.Error())
	}
	var plan codingDispatchPlan
	if err := json.Unmarshal(planned, &plan); err != nil || plan.PlanID == "" || plan.FlowID != codingDispatchFlowID {
		return d.markInfraFailed("the workspace host returned an unusable plan for " + codingDispatchFlowID)
	}

	// The plan's own approval object, decided. Never a composed decision:
	// the host owns which gates a plan carries, and a gate that asks a person
	// is not one this path may answer.
	var approval map[string]json.RawMessage
	if err := json.Unmarshal(plan.Approval, &approval); err != nil || len(approval) == 0 {
		return d.markInfraFailed("the workspace host returned no approval for the dispatched turn")
	}
	approval["decision"] = json.RawMessage(`"approve"`)
	if _, err := d.callCoding("Approval.Submit", approval); err != nil {
		return d.markInfraFailed("approve dispatched turn: " + err.Error())
	}

	launched, err := d.callCoding("Run", map[string]any{
		"_tag": "Plan", "planId": plan.PlanID, "digest": plan.Digest,
		"envelope": plan.Envelope, "idempotencyKey": key + ":run",
	})
	if err != nil {
		return d.markInfraFailed("run dispatched turn: " + err.Error())
	}
	var receipt codingDispatchRunReceipt
	if err := json.Unmarshal(launched, &receipt); err != nil || receipt.RunID == "" ||
		(receipt.Tag != "Accepted" && receipt.Tag != "AlreadyApplied" && receipt.Tag != "Terminal") {
		return d.markInfraFailed("the workspace host did not accept the dispatched turn")
	}

	// Durable before anything streams it: a poller that restarts, or another
	// process that picks the run up, finds the turn by this id alone.
	if _, err := d.svc.dispatchQ.RecordWorkflowRunCodingHost(d.ctx, clusterdb.RecordWorkflowRunCodingHostParams{
		WorkflowRunID: d.run.ID, WorkspaceID: d.workspaceID, HostRunID: receipt.RunID, FlowID: codingDispatchFlowID,
	}); err != nil {
		return d.markInfraFailed("record dispatched turn identity: " + err.Error())
	}
	logger.Info("dispatched turn accepted by the workspace coding host",
		"workspace_id", d.workspaceID, "host_run_id", receipt.RunID, "flow_id", codingDispatchFlowID)
	return nil
}

// watchCodingTurn streams the accepted turn until it ends.
//
// Detached on purpose: DispatchAgentRun answers as soon as the turn is
// accepted, exactly as it did when a guest process owned the loop. The run
// id is already durable, so this goroutine dying loses progress reporting,
// never the turn.
func (d *agentDispatch) watchCodingTurn() error {
	svc, connection, runID, sessionID, workflowRunID := d.svc, d.codingConnection(), "", d.input.SessionID, d.run.ID
	if host, err := svc.dispatchQ.GetWorkflowRunCodingHost(d.ctx, workflowRunID); err == nil {
		runID = host.HostRunID
	}
	if runID == "" {
		return nil
	}
	SafeGo("agent-coding-turn-watch", func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(d.ctx), codingDispatchDeadline)
		defer cancel()
		svc.streamDispatchedTurn(ctx, connection, sessionID, workflowRunID, runID)
	})
	return nil
}

// codingRunRow is the one control run row the poller reads.
type codingRunRow struct {
	Items []struct {
		RunID  string          `json:"runId"`
		Status string          `json:"status"`
		Output json.RawMessage `json:"output"`
	} `json:"items"`
}

var codingTerminalStatuses = map[string]string{
	"completed": "done",
	"failed":    "failed",
	"cancelled": "cancelled",
}

// streamDispatchedTurn follows one accepted turn to its end.
//
// Progress is read from the surface the host already serves: the control
// run row for status and result, and the `transcript` projection for the
// turn's frames as they happen. Neither is a new transport — `/rpc` and
// `/projections` are the two mounts `Serve.ts` lists — and both are selected
// by the host run id this dispatch recorded.
func (s *AgentService) streamDispatchedTurn(ctx context.Context, connection RepoGatewayConnectionInput, sessionID string, workflowRunID int64, hostRunID string) {
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, sessionID, workflowRunID)
	ticker := time.NewTicker(codingDispatchPollInterval)
	defer ticker.Stop()
	reported := 0
	for {
		select {
		case <-ctx.Done():
			logger.Warn("stopped following a dispatched turn", "host_run_id", hostRunID, "reason", ctx.Err())
			return
		case <-ticker.C:
		}

		// The turn's frames, so a stalled run is visible as a stalled run
		// rather than as silence. The rows themselves are the client's to
		// render off /projections; plue counts them to keep the session
		// alive and to log forward progress.
		if rows, err := s.dispatchedTurnTranscript(ctx, connection, hostRunID); err == nil && rows > reported {
			reported = rows
			s.touchAgentWorkspaceActivity(ctx, sessionID)
			notifyWorkflowRunEvent(ctx, s.dispatchQ, workflowRunID, "agent.turn_progress")
		}

		status, output, err := s.dispatchedTurnStatus(ctx, connection, hostRunID)
		if err != nil {
			logger.Warn("could not read a dispatched turn's status", "host_run_id", hostRunID, "error", err)
			continue
		}
		final, terminal := codingTerminalStatuses[status]
		if !terminal {
			continue
		}
		s.finalizeDispatchedTurn(ctx, sessionID, workflowRunID, hostRunID, final, output)
		return
	}
}

// dispatchedTurnTranscript returns how many transcript rows the turn has.
func (s *AgentService) dispatchedTurnTranscript(ctx context.Context, connection RepoGatewayConnectionInput, hostRunID string) (int, error) {
	payload, err := json.Marshal(map[string]any{"selector": map[string]any{"_tag": "transcript", "runId": hostRunID}})
	if err != nil {
		return 0, err
	}
	body, err := s.codingGateway.CallRepositoryJob(ctx, connection, codingDispatchCapability, "Projection.Snapshot", payload)
	if err != nil {
		return 0, err
	}
	var snapshot struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return 0, err
	}
	return len(snapshot.Rows), nil
}

// dispatchedTurnStatus returns the turn's control status and, once it has
// one, its result.
func (s *AgentService) dispatchedTurnStatus(ctx context.Context, connection RepoGatewayConnectionInput, hostRunID string) (string, json.RawMessage, error) {
	payload, err := json.Marshal(map[string]any{"_tag": "runs", "filters": map[string]string{"runId": hostRunID}, "limit": 1})
	if err != nil {
		return "", nil, err
	}
	body, err := s.codingGateway.CallRepositoryJob(ctx, connection, codingDispatchCapability, "List", payload)
	if err != nil {
		return "", nil, err
	}
	var rows codingRunRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return "", nil, err
	}
	if len(rows.Items) != 1 || rows.Items[0].RunID != hostRunID {
		return "", nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the workspace host does not know this turn")
	}
	return rows.Items[0].Status, rows.Items[0].Output, nil
}

// finalizeDispatchedTurn writes what the agent said and ends the session.
//
// The flow's result is the source of truth for agent_messages: it is the
// ordered set of assistant turns the flow committed to, decoded by the same
// schema the host encoded. A completed turn with no readable result is a
// failure, not an empty answer.
func (s *AgentService) finalizeDispatchedTurn(ctx context.Context, sessionID string, workflowRunID int64, hostRunID, final string, output json.RawMessage) {
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, sessionID, workflowRunID)
	lastError := ""
	if final == "done" {
		var result codingTurnResult
		if err := json.Unmarshal(output, &result); err != nil || len(result.Messages) == 0 {
			final, lastError = "failed", "the workspace host completed the turn without any assistant message"
		} else {
			for _, message := range result.Messages {
				content, err := json.Marshal(map[string]string{"type": "text", "text": message.Content})
				if err != nil {
					continue
				}
				if _, err := s.AppendMessage(ctx, sessionID, "assistant", []db.CreateAgentPartParams{
					{PartIndex: 0, PartType: "text", Content: content},
				}); err != nil {
					logger.Error("failed to persist a dispatched turn's assistant message", "host_run_id", hostRunID, "error", err)
					final, lastError = "failed", "the turn's answer could not be persisted"
					break
				}
			}
		}
	}
	if final != "done" && lastError == "" {
		lastError = "the dispatched turn ended " + final
	}
	session, transitioned, err := s.transitionAgentSessionTerminalStatus(ctx, sessionID, final)
	if err != nil {
		logger.Error("failed to end an agent session after its dispatched turn", "host_run_id", hostRunID, "error", err)
		return
	}
	if !transitioned {
		return
	}
	s.finalizeAgentSession(ctx, session, final, lastError)
	logger.Info("dispatched turn finished", "host_run_id", hostRunID, "status", final)
}
