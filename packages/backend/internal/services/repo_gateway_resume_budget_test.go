package services

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Repro apps/ui/canary-repros/honesty/22.6 and flow-sweep/A.18: the product's
// "Preparing your <repo> workspace…" stood past 120s and POST
// /api/workflow/provision timed out at 20s with no card, no error and no
// timeout. The provision path had already been bounded; the RESUME path had
// not. Resolving a gateway whose VM the provider idle-suspended ran
// StartSandbox (bounded at two minutes and retried once), the engine patch, the
// service re-declare and its retry, the seat check and the health-probe loop —
// all on the caller's connection. No client waits that long.
func TestResolveExistingGateway_AnswersConflictInsteadOfHangingOnResume(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	const (
		gatewayID = "gw-slow-resume"
		vmID      = "vm-slow-resume"
		token     = "smithers_gateway_slow_resume"
	)
	q := &fakeRepoGatewayQuerier{active: idleSuspendedGatewayRow(gatewayID, vmID, token)}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(ctx context.Context, id string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			// The wedged-VM shape: the provider accepts the resume and then
			// takes minutes to answer.
			select {
			case <-release:
			case <-ctx.Done():
				return sandbox.StartResult{}, ctx.Err()
			}
			return sandbox.StartResult{ID: id}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(20*time.Millisecond, time.Minute))

	start := time.Now()
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	elapsed := time.Since(start)

	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err), "the client taxonomy's poll-me answer, not a hung connection")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, apiErr.Code)
	assert.Equal(t, 2, apiErr.RetryAfter)
	assert.Contains(t, apiErr.Message, "resuming")
	assert.Less(t, elapsed, 2*time.Second, "the caller must be answered inside the response budget")
	// The row is untouched: a slow resume is not evidence the gateway is dead.
	assert.NotContains(t, q.getSoftDeleted(), gatewayID)
}

// A client that polls the 409 must not start a fresh multi-minute resume on
// every poll — that is how a gateway never converges. The resolve is
// singleflighted per gateway row.
func TestResolveExistingGateway_SingleflightsConcurrentResumes(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	const (
		gatewayID = "gw-polled"
		vmID      = "vm-polled"
		token     = "smithers_gateway_polled"
	)
	var starts atomic.Int64
	q := &fakeRepoGatewayQuerier{active: idleSuspendedGatewayRow(gatewayID, vmID, token)}
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(ctx context.Context, id string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
			starts.Add(1)
			select {
			case <-release:
			case <-ctx.Done():
				return sandbox.StartResult{}, ctx.Err()
			}
			return sandbox.StartResult{ID: id}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(20*time.Millisecond, time.Minute))

	for i := 0; i < 5; i++ {
		_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
		require.Error(t, err)
		assert.Equal(t, 409, apiStatus(t, err))
	}
	assert.Equal(t, int64(1), starts.Load(), "five polls, one resume")
}

// The reuse path's own verdicts still reach the caller unchanged when they
// arrive inside the budget: a row mid-provision is still the 409 it always was,
// and a healthy running gateway is still answered directly.
func TestResolveExistingGateway_FastVerdictsAreUnchanged(t *testing.T) {
	t.Parallel()

	t.Run("a row still provisioning answers its own conflict", func(t *testing.T) {
		t.Parallel()
		row := idleSuspendedGatewayRow("gw-starting", "vm-starting", "smithers_gateway_starting")
		row.Status = "starting"
		q := &fakeRepoGatewayQuerier{active: row}
		svc := newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{},
			withTestProvisionBudgets(2*time.Second, time.Minute))
		_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
		require.Error(t, err)
		assert.Equal(t, 409, apiStatus(t, err))
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, apiErr.Code)
		assert.Contains(t, apiErr.Message, "provisioning is still in progress")
	})

	t.Run("a live gateway is still served directly", func(t *testing.T) {
		t.Parallel()
		const vmID = "vm-live-fast"
		q := &fakeRepoGatewayQuerier{active: idleSuspendedGatewayRow("gw-live-fast", vmID, "smithers_gateway_live_fast")}
		vm := &fakeRepoGatewayVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
		}
		svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(2*time.Second, time.Minute))
		info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
		require.NoError(t, err)
		assert.Equal(t, vmID, info.VMID)
		assert.Equal(t, "running", info.Status)
		assert.False(t, slices.Contains(q.getSoftDeleted(), "gw-live-fast"))
	})
}
