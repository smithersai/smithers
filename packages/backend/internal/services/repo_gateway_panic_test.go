package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// A panic in the detached resolve must fail that resolve and release its
// singleflight entry; otherwise it kills the process, or every later caller
// joins a resolve that never completes.
func TestRepoGatewayService_PanickingResolveFailsAndReleasesTheGateway(t *testing.T) {
	t.Parallel()
	const gatewayID, vmID, token = "gw-panic", "vm-panic", "smithers_gateway_panic"
	q := &relayRepoGatewayQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		active: idleSuspendedGatewayRow(gatewayID, vmID, token),
	}}
	panics := true
	vm := &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			if panics {
				panic("sandbox client bug")
			}
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
	}
	svc := newTestRepoGatewayService(q, vm)
	fastRepoGatewaySleep(svc)

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.Error(t, err)

	svc.resolveMu.Lock()
	inflight := len(svc.resolveInflight)
	svc.resolveMu.Unlock()
	require.Zero(t, inflight, "a panicked resolve must release its singleflight entry")
}
