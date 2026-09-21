package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// withTestProvisionBudgets shortens both provisioning budgets so these tests
// cost milliseconds rather than the production 12s / 20m.
func withTestProvisionBudgets(response, background time.Duration) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.provisionResponseBudget = response
		s.provisionBackgroundBudget = background
	}
}

// A FRESH provision runs the ingress mapping, runtime install, workspace
// clone, pack install and service start — a multi-minute job. Production
// measured a Cloudflare-fronted POST answered 504 after 1m9.763s and a direct
// one taking 1m15.662s to return 200, so the product's "Preparing your <repo>
// workspace…" stood past 120s with nothing rendered. The route must answer
// inside a bounded budget with the 409 the client taxonomy already documents.
func TestProvisionGateway_AnswersConflictInsteadOfHangingPastTheBudget(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{
		createDomainMappingFn: func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
			select {
			case <-release:
			case <-ctx.Done():
				return sandbox.IngressRoute{}, ctx.Err()
			}
			return sandbox.IngressRoute{Hostname: domain, SandboxID: req.SandboxID, Port: req.Port}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(20*time.Millisecond, time.Minute))

	started := time.Now()
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	elapsed := time.Since(started)

	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected an APIError, got %T", err)
	assert.Equal(t, 409, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, apiErr.Code)
	assert.Equal(t, 2, apiErr.RetryAfter)
	assert.Contains(t, apiErr.Message, "still in progress")
	assert.Less(t, elapsed, 5*time.Second, "the route must not hold the connection for the whole provision")
}

// The client giving up used to CANCEL the provision mid-flight (production
// logged "probe gateway health: context canceled"), and the cleanup path then
// deleted the half-built VM — so every retry restarted from zero and the
// gateway never converged. A disconnected caller must leave the provision
// running and must never trigger teardown.
func TestProvisionGateway_CallerCancellationDoesNotTearDownTheVM(t *testing.T) {
	t.Parallel()

	mappingReached := make(chan struct{})
	proceed := make(chan struct{})
	finished := make(chan struct{})

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{
		createDomainMappingFn: func(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
			close(mappingReached)
			select {
			case <-proceed:
			case <-ctx.Done():
				return sandbox.IngressRoute{}, ctx.Err()
			}
			return sandbox.IngressRoute{Hostname: domain, SandboxID: req.SandboxID, Port: req.Port}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			close(finished)
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(time.Minute, time.Minute))

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-mappingReached
		cancel()
	}()

	_, err := svc.GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected an APIError, got %T", err)
	assert.Equal(t, 409, apiErr.Status, "a disconnected caller gets the poll-me answer, not a torn-down gateway")
	assert.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, apiErr.Code)

	// The caller is gone; the detached provision must still complete.
	close(proceed)
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("provisioning did not continue after the caller disconnected")
	}

	assert.Empty(t, vm.deletedVMIDs, "caller cancellation must never delete the VM being provisioned")
}

// A provision that completes inside the response budget still answers 200
// inline — the fast path must not regress into a mandatory poll.
func TestProvisionGateway_FastProvisionStillAnswersInline(t *testing.T) {
	t.Parallel()

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(q, vm, withTestProvisionBudgets(30*time.Second, time.Minute))

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "running", info.Status)
	assert.NotEmpty(t, info.Token)
	assert.Empty(t, vm.deletedVMIDs)
}
