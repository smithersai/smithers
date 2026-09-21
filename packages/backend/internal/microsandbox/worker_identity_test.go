package microsandbox

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkerIdentityPersistsAndSignsEveryHeartbeatField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	first, err := LoadOrCreateWorkerIdentity(path)
	require.NoError(t, err)
	second, err := LoadOrCreateWorkerIdentity(path)
	require.NoError(t, err)
	assert.True(t, bytes.Equal(first, second))
	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	heartbeat := WorkerHeartbeat{
		WorkerID: "worker-a", BootID: "boot-a", BaseURL: "https://10.0.0.2:8444",
		State: "ready", Capacity: WorkerCapacity{CPUMillis: 7000, VMs: 24},
		Inventory: []WorkerInventoryItem{{SandboxID: "msb_one", Generation: 3, State: "running"}},
	}
	require.NoError(t, SignWorkerHeartbeat(&heartbeat, first))
	require.NoError(t, VerifyWorkerHeartbeat(heartbeat))
	require.NoError(t, VerifyWorkerHeartbeatFresh(heartbeat, heartbeat.IdentitySignedAt.Add(30*time.Second), 45*time.Second, 15*time.Second))
	assert.Error(t, VerifyWorkerHeartbeatFresh(heartbeat, heartbeat.IdentitySignedAt.Add(46*time.Second), 45*time.Second, 15*time.Second))
	assert.Error(t, VerifyWorkerHeartbeatFresh(heartbeat, heartbeat.IdentitySignedAt.Add(-16*time.Second), 45*time.Second, 15*time.Second))

	tamperedRoute := heartbeat
	tamperedRoute.BaseURL = "https://attacker.internal:8444"
	assert.Error(t, VerifyWorkerHeartbeat(tamperedRoute))
	tamperedInventory := heartbeat
	tamperedInventory.Inventory = []WorkerInventoryItem{{SandboxID: "msb_one", Generation: 4, State: "running"}}
	assert.Error(t, VerifyWorkerHeartbeat(tamperedInventory))
}
