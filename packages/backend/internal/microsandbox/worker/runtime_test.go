package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	upstream "github.com/superradcompany/microsandbox/sdk/go"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestServeSSHBridgeRequiresAuthorizedKeysFile(t *testing.T) {
	err := ServeSSHBridge(context.Background(), "msb_test", "developer", "  ")
	require.EqualError(t, err, "Microsandbox SSH authorized keys file is required")
}

func TestSnapshotArchiveMetadataHashesTransferredBytes(t *testing.T) {
	payload := []byte("plain-tar-snapshot-bytes")
	archive := filepath.Join(t.TempDir(), "snapshot.tar")
	require.NoError(t, os.WriteFile(archive, payload, 0o600))
	digest, size, err := snapshotArchiveMetadata(archive)
	require.NoError(t, err)
	sum := sha256.Sum256(payload)
	assert.Equal(t, "sha256:"+hex.EncodeToString(sum[:]), digest)
	assert.EqualValues(t, len(payload), size)
}

func TestSnapshotImportRejectsPathsAndDigestSelectors(t *testing.T) {
	for _, id := range []string{"", ".", "..", "/tmp/snapshot", "../snapshot", `a\b`, "sha256:abc", "id with spaces"} {
		t.Run(id, func(t *testing.T) {
			_, err := NewSDKRuntime().ImportSnapshot(context.Background(), id, "/archive-must-not-be-read")
			require.EqualError(t, err, "invalid local snapshot id")
		})
	}
}

func TestSyncSandboxUpperFlushesRunScopedRuntimeImage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	upper := filepath.Join(home, ".microsandbox", "sandboxes", "msb_test", "upper.ext4")
	require.NoError(t, os.MkdirAll(filepath.Dir(upper), 0o700))
	require.NoError(t, os.WriteFile(upper, []byte("ext4-image"), 0o600))

	require.NoError(t, syncSandboxUpper("msb_test"))
	require.Error(t, syncSandboxUpper("msb_missing"))
}

func TestExecFailsClosedBeforeRuntimeWhenSecretsArePresent(t *testing.T) {
	// The typed refusal must fire before any SDK connection: a sandbox ID that
	// does not exist proves the runtime was never consulted.
	runtime := NewSDKRuntime()
	sentinel := "PLUE_SECRET_SENTINEL_fail_closed_unit"
	_, err := runtime.Exec(context.Background(), "msb_does_not_exist", sandbox.ExecRequest{
		Command: "true",
		Secrets: map[string]string{"API_TOKEN": sentinel},
	})
	require.ErrorIs(t, err, ErrSecretDeliveryUnavailable)
	assert.NotContains(t, err.Error(), sentinel)
}

func TestExecTimeoutAlwaysHasServerSideBound(t *testing.T) {
	assert.Equal(t, 30*time.Minute, boundedExecTimeout(nil))
	requested := int64((5 * time.Second) / time.Millisecond)
	assert.Equal(t, 5*time.Second, boundedExecTimeout(&requested))
	unbounded := int64((2 * time.Hour) / time.Millisecond)
	assert.Equal(t, 30*time.Minute, boundedExecTimeout(&unbounded))
}

func TestBashExecCommandPreservesCompleteScriptAsOneArgument(t *testing.T) {
	script := "set -euo pipefail\nprintf '%s\\n' \"$HOME\"\nvalue='it'\"'\"'s safe'"
	assert.Equal(t, "exec /bin/bash -lc "+shellQuote(script), bashExecCommand(script))
}

func TestNetworkPolicyUsesRuntimePublicOnlyDefault(t *testing.T) {
	t.Parallel()
	policy := networkPolicy(sandbox.CreateRequest{})
	assert.Nil(t, policy)
}

func TestNetworkPolicyCanDisableAllNetworking(t *testing.T) {
	t.Parallel()
	policy := networkPolicy(sandbox.CreateRequest{Internet: "none"})
	assert.Equal(t, upstream.PolicyActionDeny, policy.DefaultEgress)
	assert.Equal(t, upstream.PolicyActionDeny, policy.DefaultIngress)
}

func TestNetworkPolicyMapsDefaultDenyAllowlist(t *testing.T) {
	t.Parallel()
	policy := networkPolicy(sandbox.CreateRequest{Firewall: &sandbox.FirewallPolicy{
		DefaultEgressAction: "deny",
		EgressAllow:         []sandbox.FirewallEgressRule{{Host: "api.github.com", Port: 443, Protocol: "tcp"}},
	}})
	assert.Equal(t, upstream.PolicyActionDeny, policy.DefaultEgress)
	require.Len(t, policy.Rules, 1)
	assert.Equal(t, "api.github.com", policy.Rules[0].Destination)
	assert.Equal(t, "443", policy.Rules[0].Port)
	assert.Equal(t, upstream.PolicyProtocolTCP, policy.Rules[0].Protocol)
}

func TestDeleteRuntimeOnTerminalHonorsDeclaredEphemeralLifecycle(t *testing.T) {
	deleteOnStop := sandbox.DeleteOnStop
	assert.True(t, deleteRuntimeOnTerminal(sandbox.CreateRequest{Persistence: &sandbox.PersistencePolicy{
		Type: sandbox.PersistenceEphemeral, DeleteEvent: &deleteOnStop,
	}}))
	assert.False(t, deleteRuntimeOnTerminal(sandbox.CreateRequest{}))
	assert.False(t, deleteRuntimeOnTerminal(sandbox.CreateRequest{Persistence: &sandbox.PersistencePolicy{
		Type: sandbox.PersistencePersistent, DeleteEvent: &deleteOnStop,
	}}))
}

func TestGuestBootOptionsSelectInitByKind(t *testing.T) {
	for _, kind := range []string{"vm", "desktop"} {
		config := upstream.SandboxConfig{}
		for _, option := range guestBootOptions(kind) {
			option(&config)
		}
		require.NotNil(t, config.Init)
		assert.Equal(t, "auto", config.Init.Cmd)
		assert.Empty(t, config.Entrypoint)
	}

	config := upstream.SandboxConfig{}
	for _, option := range guestBootOptions("container") {
		option(&config)
	}
	assert.Nil(t, config.Init)
	assert.Equal(t, []string{"/bin/sh", "-lc", "while :; do sleep 3600; done"}, config.Entrypoint)
	assert.Equal(t, "container", normalizeCreateRequest(sandbox.CreateRequest{Kind: "invalid"}).Kind)
}

func TestServiceLaunchCommandWaitsForReadySignalService(t *testing.T) {
	ready := true
	command, timeout := serviceLaunchCommand(sandbox.ServiceSpec{
		Exec:        []string{"/usr/local/bin/smithers-desktop-start"},
		ReadySignal: &ready,
	}, "/tmp/desktop.log")
	assert.Equal(t, "exec /usr/local/bin/smithers-desktop-start", command)
	assert.Equal(t, 2*time.Minute, timeout)
	assert.NotContains(t, command, "setsid")

	command, timeout = serviceLaunchCommand(sandbox.ServiceSpec{
		Exec: []string{"/usr/local/bin/background-worker"},
	}, "/tmp/background.log")
	assert.Contains(t, command, "setsid")
	assert.Contains(t, command, "/tmp/background.log")
	assert.Equal(t, 30*time.Second, timeout)
}
