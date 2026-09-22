// Package flowdispatch durably maps product requests onto the canonical
// TypeScript Flow runtime. It owns admission and receipt projection only; the
// runtime host remains the sole graph, journal, approval, and execution owner.
package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	OperationLaunch  = "flow.runtime.launch"
	OperationApprove = "flow.runtime.approve"
)

var (
	ErrApprovalUnavailable = errors.New("flow dispatch: approval is not available")
	ErrNotLaunchOperation  = errors.New("flow dispatch: operation is not a Flow launch")
)

type ApprovalPolicy string

const (
	ApprovalManual ApprovalPolicy = "manual"
	ApprovalAuto   ApprovalPolicy = "approve"
)

// LaunchRequest is product admission data. Payload is the canonical Flow
// input; Projection is opaque product correlation metadata and never runtime
// graph state.
type LaunchRequest struct {
	Scope                jobs.Scope
	RequestID            string
	Target               flowruntime.FlowRuntimeTarget
	FlowID               string
	Payload              json.RawMessage
	AuthorizationContext json.RawMessage
	Projection           json.RawMessage
	ApprovalPolicy       ApprovalPolicy
}

type RuntimeCheckpoint struct {
	Version             int                             `json:"version"`
	Target              flowruntime.FlowRuntimeTarget   `json:"target"`
	FlowID              string                          `json:"flowId"`
	Projection          json.RawMessage                 `json:"projection"`
	Identity            flowruntime.FlowRuntimeIdentity `json:"identity"`
	PlanID              string                          `json:"planId,omitempty"`
	Approval            json.RawMessage                 `json:"approval,omitempty"`
	ApprovalOperationID string                          `json:"approvalOperationId,omitempty"`
	Receipt             *flowruntime.FlowRuntimeReceipt `json:"receipt,omitempty"`
	MutationReceipt     *flowruntime.FlowRuntimeReceipt `json:"mutationReceipt,omitempty"`
	RunID               string                          `json:"runId,omitempty"`
	Cursor              string                          `json:"cursor,omitempty"`
	Run                 *flowruntime.FlowRuntimeRun     `json:"run,omitempty"`
}

// ProjectionUpdate is an idempotent projection callback. RuntimeCheckpoint is
// evidence from Control, not an alternate run-state authority.
type ProjectionUpdate struct {
	OperationID string
	Scope       jobs.Scope
	State       jobs.State
	Checkpoint  RuntimeCheckpoint
}

type Projector interface {
	ProjectFlowRuntime(context.Context, ProjectionUpdate) error
}

type ProjectorFunc func(context.Context, ProjectionUpdate) error

func (project ProjectorFunc) ProjectFlowRuntime(ctx context.Context, update ProjectionUpdate) error {
	return project(ctx, update)
}

type Config struct {
	Store              *jobs.Store
	Resolver           flowruntime.FlowRuntimeResolver
	Projector          Projector
	ObservationDelay   time.Duration
	ObservationLimit   int
	ObservationPages   int
	RuntimeCallTimeout time.Duration
}

type launchPayload struct {
	Target         flowruntime.FlowRuntimeTarget `json:"target"`
	FlowID         string                        `json:"flowId"`
	Payload        json.RawMessage               `json:"payload"`
	Projection     json.RawMessage               `json:"projection"`
	ApprovalPolicy ApprovalPolicy                `json:"approvalPolicy"`
}

type approvalPayload struct {
	LaunchOperationID string                          `json:"launchOperationId"`
	Target            flowruntime.FlowRuntimeTarget   `json:"target"`
	Identity          flowruntime.FlowRuntimeIdentity `json:"identity"`
	Approval          json.RawMessage                 `json:"approval"`
}

type terminalReceipt struct {
	Kind       string                          `json:"kind"`
	Runtime    flowruntime.FlowRuntimeIdentity `json:"runtime"`
	Receipt    *flowruntime.FlowRuntimeReceipt `json:"receipt,omitempty"`
	Run        *flowruntime.FlowRuntimeRun     `json:"run,omitempty"`
	Cursor     string                          `json:"cursor,omitempty"`
	ErrorCode  string                          `json:"errorCode,omitempty"`
	Projection json.RawMessage                 `json:"projection"`
}
