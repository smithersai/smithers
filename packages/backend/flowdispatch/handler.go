package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type safeFailure struct {
	code      string
	retryable bool
}

func (failure safeFailure) Error() string { return "flow dispatch: " + failure.code }

func (service *Service) Handle(ctx context.Context, lease *jobs.Lease) error {
	if lease == nil {
		return errors.New("flow dispatch: lease is required")
	}
	switch lease.Claim().Operation {
	case OperationLaunch:
		return service.handleLaunch(ctx, lease)
	case OperationApprove:
		return service.handleApproval(ctx, lease)
	default:
		return errors.New("flow dispatch: unsupported product operation")
	}
}

func (service *Service) handleLaunch(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload launchPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil {
		return service.fail(lease, "invalid_product_request", RuntimeCheckpoint{})
	}
	checkpoint, err := decodeCheckpoint(claim.ExternalReceipt)
	if err != nil {
		return service.fail(lease, "invalid_checkpoint", RuntimeCheckpoint{Projection: payload.Projection})
	}
	if checkpoint.Version == 0 {
		checkpoint = RuntimeCheckpoint{
			Version: 1, Target: payload.Target, FlowID: payload.FlowID, Projection: payload.Projection,
		}
	}
	if checkpoint.FlowID != payload.FlowID || checkpoint.Target != payload.Target {
		return service.fail(lease, "checkpoint_request_mismatch", checkpoint)
	}
	// No external checkpoint means Control has never seen this launch. A
	// cancellation already present on the claim can therefore settle locally;
	// it must not wait for (or accidentally start) an unavailable host.
	if claim.CancellationRequested && len(claim.ExternalReceipt) == 0 {
		return service.settleBeforeLaunchCancellation(ctx, lease, checkpoint)
	}
	runtime, identity, err := service.resolve(ctx, checkpoint.Target, checkpoint.Identity)
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	checkpoint.Identity = identity
	marker, err := json.Marshal(checkpoint)
	if err != nil {
		return err
	}
	if err := lease.StartExternal(ctx, marker); err != nil {
		if errors.Is(err, jobs.ErrCancellationRequested) {
			return service.settleBeforeLaunchCancellation(ctx, lease, checkpoint)
		}
		return err
	}

	// A durable run id means launch acceptance already happened. Reconnect only
	// through Observe; never infer progress from product rows or host readiness.
	if checkpoint.RunID != "" {
		if claim.CancellationRequested {
			if err := service.cancelRun(ctx, runtime, lease, &checkpoint); err != nil {
				return err
			}
		}
		return service.observe(ctx, runtime, lease, checkpoint)
	}

	result, err := service.launch(ctx, runtime, identity, claim.OperationID, int64(lease.DeliveryAttempt()), payload)
	if err != nil {
		if claim.CancellationRequested && runtimeCode(err) == "plan_denied" {
			return service.settleDenied(ctx, lease, checkpoint, "plan_denied")
		}
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validLaunchResult(result, identity, claim.OperationID) {
		return service.fail(lease, "runtime_launch_identity_mismatch", checkpoint)
	}
	checkpoint.PlanID = result.PlanID
	checkpoint.Approval = result.Approval
	checkpoint.Receipt = &result.Receipt
	checkpoint.RunID = result.Receipt.RunID

	switch result.Receipt.Tag {
	case "Parked":
		if checkpoint.PlanID == "" || len(checkpoint.Approval) == 0 {
			return service.fail(lease, "invalid_parked_receipt", checkpoint)
		}
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if claim.CancellationRequested {
			return service.denyPlan(ctx, runtime, lease, checkpoint)
		}
		if payload.ApprovalPolicy == ApprovalAuto {
			decision, err := service.admitApproval(
				context.WithoutCancel(ctx), claim.Scope, claim.OperationID,
				claim.OperationID+":auto-approve", claim.AuthorizationContext, checkpoint,
			)
			if err != nil {
				return safeFailure{code: "approval_admission_unavailable", retryable: true}
			}
			checkpoint.ApprovalOperationID = decision.OperationID
			if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
				return err
			}
		}
		return lease.Defer(ctx, mustJSON(checkpoint), service.observationDelay)
	case "Accepted", "AlreadyApplied":
		if checkpoint.RunID == "" {
			return service.fail(lease, "runtime_receipt_missing_run", checkpoint)
		}
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if claim.CancellationRequested {
			if err := service.cancelRun(ctx, runtime, lease, &checkpoint); err != nil {
				return err
			}
		}
		return service.observe(ctx, runtime, lease, checkpoint)
	case "Terminal":
		if !terminalStatus(result.Receipt.Status) || result.Receipt.RunID == "" {
			return service.fail(lease, "invalid_terminal_receipt", checkpoint)
		}
		checkpoint.Run = &flowruntime.FlowRuntimeRun{
			RunID: result.Receipt.RunID, FlowID: payload.FlowID, Status: result.Receipt.Status, PlanID: result.PlanID,
		}
		return service.settle(ctx, lease, checkpoint)
	case "Conflict":
		return service.fail(lease, "runtime_conflict", checkpoint)
	default:
		return service.fail(lease, "invalid_runtime_receipt", checkpoint)
	}
}

func (service *Service) settleBeforeLaunchCancellation(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	if err := service.project(context.WithoutCancel(ctx), lease, jobs.StateCancelled, checkpoint); err != nil {
		return err
	}
	return lease.Cancelled(ctx, mustJSON(terminalReceipt{
		Kind:       "cancelled-before-runtime-launch",
		Runtime:    checkpoint.Identity,
		Projection: checkpoint.Projection,
	}))
}

func (service *Service) launch(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	identity flowruntime.FlowRuntimeIdentity,
	operationID string,
	attempt int64,
	payload launchPayload,
) (flowruntime.FlowRuntimeLaunchResult, error) {
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	defer cancel()
	return runtime.Launch(callContext, flowruntime.FlowRuntimeLaunch{
		ApplicationRequestID: operationID, Attempt: attempt, OwnerGeneration: identity.OwnerGeneration,
		RuntimeArtifactDigest: identity.RuntimeArtifactDigest, SourceRevision: identity.SourceRevision,
		FlowID: payload.FlowID, Payload: payload.Payload,
	})
}

func (service *Service) handleApproval(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload approvalPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil || len(payload.Approval) == 0 {
		return service.fail(lease, "invalid_approval_request", RuntimeCheckpoint{})
	}
	origin, err := service.store.Get(ctx, claim.Scope, payload.LaunchOperationID)
	if err != nil {
		return safeFailure{code: "launch_projection_unavailable", retryable: true}
	}
	if origin.Operation != OperationLaunch || origin.State.Terminal() || origin.CancellationRequested {
		return service.fail(lease, "approval_no_longer_available", RuntimeCheckpoint{})
	}
	runtime, identity, err := service.resolve(ctx, payload.Target, payload.Identity)
	if err != nil {
		return service.runtimeError(lease, err, RuntimeCheckpoint{Identity: payload.Identity})
	}
	checkpoint := RuntimeCheckpoint{
		Version: 1, Target: payload.Target, Identity: identity, Approval: payload.Approval,
	}
	if err := lease.StartExternal(ctx, mustJSON(checkpoint)); err != nil {
		return err
	}
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	result, err := runtime.Approve(callContext, flowruntime.FlowRuntimeDecision{
		ApplicationRequestID: claim.OperationID, OwnerGeneration: identity.OwnerGeneration, Approval: payload.Approval,
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validMutationResult(result, "approve", claim.OperationID) {
		return service.fail(lease, "invalid_approval_receipt", checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	receipt := terminalReceipt{
		Kind: "runtime-approval", Runtime: identity, Receipt: &result.Receipt, Projection: json.RawMessage(`{}`),
	}
	return lease.Complete(ctx, mustJSON(receipt))
}

func (service *Service) resolve(
	ctx context.Context,
	target flowruntime.FlowRuntimeTarget,
	pinned flowruntime.FlowRuntimeIdentity,
) (flowruntime.FlowRuntime, flowruntime.FlowRuntimeIdentity, error) {
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	defer cancel()
	runtime, err := service.resolver.ResolveFlowRuntime(callContext, target)
	if err != nil || runtime == nil {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "runtime_unavailable", retryable: true}
	}
	identity, err := runtime.Identity(callContext)
	if err != nil {
		return nil, flowruntime.FlowRuntimeIdentity{}, err
	}
	if !validIdentity(identity) {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "invalid_runtime_identity"}
	}
	if pinned.Protocol != "" && (pinned.Protocol != identity.Protocol ||
		pinned.RuntimeArtifactDigest != identity.RuntimeArtifactDigest || pinned.SourceRevision != identity.SourceRevision) {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "runtime_identity_changed"}
	}
	return runtime, identity, nil
}

func (service *Service) observe(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	for page := 0; page < service.observationPages; page++ {
		callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
		observation, err := runtime.Observe(callContext, checkpoint.RunID, checkpoint.Cursor, service.observationLimit)
		cancel()
		if err != nil {
			return service.runtimeError(lease, err, checkpoint)
		}
		if observation.Run.RunID != checkpoint.RunID || observation.Run.FlowID != checkpoint.FlowID ||
			observation.Terminal != terminalStatus(observation.Run.Status) ||
			!validObservationPage(checkpoint.Cursor, observation) {
			return service.fail(lease, "invalid_runtime_observation", checkpoint)
		}
		checkpoint.Cursor = observation.NextCursor
		checkpoint.Run = &observation.Run
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if observation.Terminal {
			return service.settle(ctx, lease, checkpoint)
		}
		if !observation.HasMore {
			break
		}
	}
	return lease.Defer(ctx, mustJSON(checkpoint), service.observationDelay)
}

func (service *Service) cancelRun(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint *RuntimeCheckpoint,
) error {
	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.runtimeCallTimeout)
	result, err := runtime.Cancel(callContext, flowruntime.FlowRuntimeLifecycle{
		ApplicationRequestID: lease.Claim().OperationID + ":cancel",
		OwnerGeneration:      checkpoint.Identity.OwnerGeneration,
		RunID:                checkpoint.RunID,
		Reason:               "product cancellation requested",
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, *checkpoint)
	}
	if !validMutationResult(result, "cancel", lease.Claim().OperationID+":cancel") {
		return service.fail(lease, "invalid_cancellation_receipt", *checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	return service.checkpoint(context.WithoutCancel(ctx), lease, *checkpoint, jobs.StateWaiting)
}

func (service *Service) denyPlan(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.runtimeCallTimeout)
	result, err := runtime.Deny(callContext, flowruntime.FlowRuntimeDecision{
		ApplicationRequestID: lease.Claim().OperationID + ":deny",
		OwnerGeneration:      checkpoint.Identity.OwnerGeneration,
		Approval:             checkpoint.Approval,
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validMutationResult(result, "deny", lease.Claim().OperationID+":deny") {
		return service.fail(lease, "invalid_denial_receipt", checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	return service.settleDenied(ctx, lease, checkpoint, "runtime-plan-denied")
}

func (service *Service) settleDenied(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
	kind string,
) error {
	if err := service.project(context.WithoutCancel(ctx), lease, jobs.StateCancelled, checkpoint); err != nil {
		return err
	}
	receipt := terminalReceipt{
		Kind: kind, Runtime: checkpoint.Identity, Receipt: checkpoint.MutationReceipt,
		Projection: checkpoint.Projection,
	}
	return lease.Cancelled(ctx, mustJSON(receipt))
}

func (service *Service) settle(ctx context.Context, lease *jobs.Lease, checkpoint RuntimeCheckpoint) error {
	if checkpoint.Run == nil || !terminalStatus(checkpoint.Run.Status) {
		return service.fail(lease, "runtime_not_terminal", checkpoint)
	}
	state := jobs.StateFailed
	switch checkpoint.Run.Status {
	case "completed":
		state = jobs.StateCompleted
	case "cancelled":
		state = jobs.StateCancelled
	}
	if err := service.project(context.WithoutCancel(ctx), lease, state, checkpoint); err != nil {
		return err
	}
	receipt := mustJSON(terminalReceipt{
		Kind: "runtime-terminal", Runtime: checkpoint.Identity, Receipt: checkpoint.Receipt,
		Run: checkpoint.Run, Cursor: checkpoint.Cursor, Projection: checkpoint.Projection,
	})
	switch state {
	case jobs.StateCompleted:
		return lease.Complete(ctx, receipt)
	case jobs.StateCancelled:
		if lease.Claim().CancellationRequested {
			return lease.Cancelled(ctx, receipt)
		}
		return lease.ExternalCancelled(ctx, receipt)
	default:
		return lease.Fail(ctx, receipt)
	}
}

func (service *Service) checkpoint(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
	state jobs.State,
) error {
	if err := lease.Waiting(context.WithoutCancel(ctx), mustJSON(checkpoint)); err != nil {
		return err
	}
	return service.project(context.WithoutCancel(ctx), lease, state, checkpoint)
}

func (service *Service) project(ctx context.Context, lease *jobs.Lease, state jobs.State, checkpoint RuntimeCheckpoint) error {
	if service.projector == nil {
		return nil
	}
	if err := service.projector.ProjectFlowRuntime(ctx, ProjectionUpdate{
		OperationID: lease.Claim().OperationID, Scope: lease.Claim().Scope, State: state, Checkpoint: checkpoint,
	}); err != nil {
		return safeFailure{code: "product_projection_unavailable", retryable: true}
	}
	return nil
}

func (service *Service) fail(lease *jobs.Lease, code string, checkpoint RuntimeCheckpoint) error {
	if len(checkpoint.Projection) > 0 {
		projectionContext, cancel := context.WithTimeout(context.Background(), service.runtimeCallTimeout)
		err := service.project(projectionContext, lease, jobs.StateFailed, checkpoint)
		cancel()
		if err != nil {
			return err
		}
	}
	receipt := terminalReceipt{
		Kind: "bridge-refused", Runtime: checkpoint.Identity, Receipt: checkpoint.Receipt,
		Run: checkpoint.Run, Cursor: checkpoint.Cursor, ErrorCode: code, Projection: checkpoint.Projection,
	}
	settleContext, cancel := context.WithTimeout(context.Background(), service.runtimeCallTimeout)
	defer cancel()
	return lease.Fail(settleContext, mustJSON(receipt))
}

func (service *Service) runtimeError(lease *jobs.Lease, err error, checkpoint RuntimeCheckpoint) error {
	code, retryable := runtimeFailure(err)
	if retryable {
		return safeFailure{code: code, retryable: true}
	}
	return service.fail(lease, code, checkpoint)
}

func runtimeFailure(err error) (string, bool) {
	var bridgeFailure flowruntime.FlowRuntimeFailure
	if errors.As(err, &bridgeFailure) {
		code := strings.TrimSpace(bridgeFailure.FlowRuntimeCode())
		if code == "" {
			code = "runtime_refused"
		}
		return code, bridgeFailure.FlowRuntimeRetryable()
	}
	var local safeFailure
	if errors.As(err, &local) {
		return local.code, local.retryable
	}
	return "runtime_unavailable", true
}

func runtimeCode(err error) string {
	code, _ := runtimeFailure(err)
	return code
}

func terminalStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func validLaunchResult(result flowruntime.FlowRuntimeLaunchResult, identity flowruntime.FlowRuntimeIdentity, operationID string) bool {
	return result.ApplicationRequestID == operationID && result.OwnerGeneration == identity.OwnerGeneration &&
		result.RuntimeArtifactDigest == identity.RuntimeArtifactDigest && result.SourceRevision == identity.SourceRevision
}

func validMutationResult(result flowruntime.FlowRuntimeMutationResult, operation, requestID string) bool {
	if result.Operation != operation || result.ApplicationRequestID != requestID {
		return false
	}
	switch result.Receipt.Tag {
	case "Accepted", "AlreadyApplied", "Terminal":
		return true
	default:
		return false
	}
}

func validObservationPage(previous string, observation flowruntime.FlowRuntimeObservation) bool {
	// Control journals start at sequence zero. An absent cursor means no
	// event has been consumed; an explicit "0" means event zero was consumed.
	before := int64(-1)
	if previous != "" {
		parsed, err := strconv.ParseInt(previous, 10, 64)
		if err != nil || parsed < 0 {
			return false
		}
		before = parsed
	}
	next, err := strconv.ParseInt(observation.NextCursor, 10, 64)
	if err != nil || next < before || (observation.HasMore && next == before) {
		return false
	}
	last := before
	for _, event := range observation.Events {
		sequence := event.Sequence
		if event.Cursor != nil {
			sequence = event.Cursor.Sequence
		}
		if sequence <= last || sequence > next {
			return false
		}
		last = sequence
	}
	return true
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("flow dispatch: encode internal receipt: %v", err))
	}
	return encoded
}
