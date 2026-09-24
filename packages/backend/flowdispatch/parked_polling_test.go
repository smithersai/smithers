package flowdispatch

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// A launch parked on manual approval must back off instead of re-launching
// at the base delay, and an approval must wake it without waiting out that
// backoff.
func TestParkedManualApprovalBacksOffAndApprovalWakesTheLaunch(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.requireApproval = true
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}),
		ObservationDelay: 10 * time.Millisecond, MaxObservationDelay: 10 * time.Second,
	})
	require.NoError(t, err)
	startTestWorker(t, service, "flow-worker")

	request := testLaunchRequest("parked-manual", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && len(operation.ExternalReceipt) > 0
	})
	time.Sleep(2 * time.Second)
	runtime.mu.Lock()
	parkedLaunches := len(runtime.launches)
	runtime.mu.Unlock()
	// A 10ms fixed poll makes about 200 launches in two seconds; doubling from
	// 10ms makes about eight.
	require.LessOrEqual(t, parkedLaunches, 15, "a parked launch re-launched without backoff")
	head, err := store.Head(context.Background(), request.Scope)
	require.NoError(t, err)
	time.Sleep(time.Second)
	idleHead, err := store.Head(context.Background(), request.Scope)
	require.NoError(t, err)
	require.LessOrEqual(t, idleHead-head, int64(2), "idle parked polls kept appending journal events")

	approvedAt := time.Now()
	_, err = service.Approve(context.Background(), request.Scope, receipt.OperationID, "parked-manual-approval", request.AuthorizationContext)
	require.NoError(t, err)
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted
	})
	require.Less(t, time.Since(approvedAt), 3*time.Second, "the approved launch waited out its backoff")
}
