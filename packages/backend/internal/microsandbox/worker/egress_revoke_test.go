package worker

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// A revocation must stop the sandbox's proxy at once, drop its marker so a
// restart does not resurrect it, record why, and let a fresh Start
// re-authorize the same sandbox.
func TestEgressProxyManagerRevokeStopsProxyAndRecordsReason(t *testing.T) {
	binary := ironProxyBinary(t)
	ca, err := ironproxy.GenerateCA("revoke", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{Binary: binary, Dir: t.TempDir(), CA: ca, StartTimeout: 15 * time.Second, PortMin: 42200, PortMax: 42299})
	require.NoError(t, err)
	t.Cleanup(manager.StopAll)
	policy := &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
		Name: "K", Value: "v", Hosts: []string{"example.test"}, MatchHeaders: []string{"authorization"},
	}}}
	_, err = manager.Start(context.Background(), "msb_revoked", policy)
	require.NoError(t, err)
	_, live := manager.Endpoint("msb_revoked")
	require.True(t, live)

	started := time.Now()
	manager.Revoke("msb_revoked", "agent session cancelled")
	require.Less(t, time.Since(started), 5*time.Second, "revocation must not wait on the process")

	_, live = manager.Endpoint("msb_revoked")
	require.False(t, live, "proxy still answers after revocation")
	require.False(t, manager.Required("msb_revoked"), "marker must be dropped so a restart does not fail closed on a revoked sandbox")
	reason, revoked := manager.Revoked("msb_revoked")
	require.True(t, revoked)
	require.Equal(t, "agent session cancelled", reason)

	// A fresh Start re-authorizes the sandbox.
	_, err = manager.Start(context.Background(), "msb_revoked", policy)
	require.NoError(t, err)
	_, revoked = manager.Revoked("msb_revoked")
	require.False(t, revoked)
	_, live = manager.Endpoint("msb_revoked")
	require.True(t, live)
}

// The runtime hook reports whether there was a live proxy to tear down; a
// sandbox that never had one is the goal state already, not an error.
func TestSDKRuntimeRevokeEgressReportsWhetherAProxyWasLive(t *testing.T) {
	runtime := &SDKRuntime{}
	result, err := runtime.RevokeEgress(context.Background(), "msb_none", sandbox.EgressRevokeRequest{Reason: "x"})
	require.NoError(t, err)
	require.Equal(t, "msb_none", result.SandboxID)
	require.False(t, result.Revoked)
}
