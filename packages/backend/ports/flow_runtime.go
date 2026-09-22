package ports

import (
	"context"
	"encoding/json"
)

// FlowRuntimeProtocol is the exact Go-to-TypeScript bridge version. A client
// must refuse any other value before attempting a launch.
const FlowRuntimeProtocol = "smithers.flow-runtime/v1"

type FlowRuntimeIdentity struct {
	Protocol              string `json:"protocol"`
	RuntimeArtifactDigest string `json:"runtimeArtifactDigest"`
	SourceRevision        string `json:"sourceRevision"`
	OwnerGeneration       int64  `json:"ownerGeneration"`
}

// FlowRuntimeLaunch names immutable work already admitted by the product.
// Attempt is delivery attempt identity, not a Flow retry; Control and the
// engine remain the only owners of Flow retry and replay semantics.
type FlowRuntimeLaunch struct {
	ApplicationRequestID  string
	Attempt               int64
	OwnerGeneration       int64
	RuntimeArtifactDigest string
	SourceRevision        string
	FlowID                string
	Payload               json.RawMessage
}

// FlowRuntimeReceipt is the canonical Control mutation receipt projected onto
// Go. Tag is Accepted, AlreadyApplied, Parked, Conflict, or Terminal.
type FlowRuntimeReceipt struct {
	Tag       string `json:"_tag"`
	ReceiptID string `json:"receiptId,omitempty"`
	RunID     string `json:"runId,omitempty"`
	PlanID    string `json:"planId,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
}

// FlowRuntimeLaunchResult records runtime acceptance separately from product
// admission. Approval is opaque canonical Control data and must be returned
// unchanged when an operator decides it.
type FlowRuntimeLaunchResult struct {
	ApplicationRequestID  string
	OwnerGeneration       int64
	RuntimeArtifactDigest string
	SourceRevision        string
	PlanID                string
	Approval              json.RawMessage
	Receipt               FlowRuntimeReceipt
}

type FlowRuntimeDecision struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	Approval             json.RawMessage
}

type FlowRuntimeSignal struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	Name                 string
	Payload              json.RawMessage
}

// FlowRuntimeSteer carries the four canonical steering variants. Only fields
// belonging to Kind are sent by the adapter.
type FlowRuntimeSteer struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	MessageID            string
	CreatedAt            float64
	Kind                 string
	Body                 string
	Seat                 string
	Thinking             string
	ToolNames            []string
}

type FlowRuntimeLifecycle struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	Reason               string
}

type FlowRuntimeMutationResult struct {
	Operation            string
	ApplicationRequestID string
	Receipt              FlowRuntimeReceipt
}

type FlowRuntimeEventCursor struct {
	Sequence int64  `json:"sequence"`
	Offset   *int64 `json:"offset,omitempty"`
}

type FlowRuntimeEvent struct {
	Cursor     *FlowRuntimeEventCursor `json:"cursor,omitempty"`
	Sequence   int64                   `json:"sequence"`
	Kind       string                  `json:"kind"`
	RunID      string                  `json:"runId,omitempty"`
	OccurredAt float64                 `json:"occurredAt"`
	Payload    json.RawMessage         `json:"payload"`
}

type FlowRuntimeRun struct {
	RunID                string `json:"runId"`
	FlowID               string `json:"flowId"`
	Status               string `json:"status"`
	PlanID               string `json:"planId,omitempty"`
	PlanDigest           string `json:"planDigest,omitempty"`
	OwnerID              string `json:"ownerId,omitempty"`
	WaitingReason        string `json:"waitingReason,omitempty"`
	ExecutionObservation string `json:"executionObservation,omitempty"`
}

type FlowRuntimeObservation struct {
	Run        FlowRuntimeRun
	Events     []FlowRuntimeEvent
	NextCursor string
	HasMore    bool
	Terminal   bool
}

// FlowRuntime is the deployment-neutral port to the one canonical TypeScript
// Control host. Both a trusted local process and Plue's isolated adapter supply
// this same behavior.
type FlowRuntime interface {
	Identity(ctx context.Context) (FlowRuntimeIdentity, error)
	Launch(ctx context.Context, request FlowRuntimeLaunch) (FlowRuntimeLaunchResult, error)
	Approve(ctx context.Context, request FlowRuntimeDecision) (FlowRuntimeMutationResult, error)
	Deny(ctx context.Context, request FlowRuntimeDecision) (FlowRuntimeMutationResult, error)
	Signal(ctx context.Context, request FlowRuntimeSignal) (FlowRuntimeMutationResult, error)
	Steer(ctx context.Context, request FlowRuntimeSteer) (FlowRuntimeMutationResult, error)
	Cancel(ctx context.Context, request FlowRuntimeLifecycle) (FlowRuntimeMutationResult, error)
	Resume(ctx context.Context, request FlowRuntimeLifecycle) (FlowRuntimeMutationResult, error)
	Observe(ctx context.Context, runID, afterCursor string, limit int) (FlowRuntimeObservation, error)
}
