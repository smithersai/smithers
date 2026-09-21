package worker

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestEgressResumeReservesSuspendedGuestPort(t *testing.T) {
	dir := t.TempDir()
	manager := &EgressProxyManager{markers: dir, config: EgressProxyConfig{PortMin: 42300, PortMax: 42300, BindHost: "127.0.0.1"}}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "sleeping.port"), []byte("42300\n"), 0600))
	_, err := manager.allocatePortLocked()
	require.ErrorIs(t, err, ErrEgressProxyUnavailable, "a suspended guest's firewall still permits this port; another tenant must not receive it")
}

func TestEgressResumeFailsClosedWithoutRetainedPort(t *testing.T) {
	manager := &EgressProxyManager{markers: t.TempDir(), config: EgressProxyConfig{PortMin: 42300, PortMax: 42399}}
	policy := &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{Name: "KEY", Value: "never-guest-token", Hosts: []string{"example.com"}}}}
	_, err := manager.Resume(context.Background(), "missing", policy)
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	assert.NotContains(t, err.Error(), "never-guest-token")
	_, err = NewSDKRuntime().StartWithEgress(context.Background(), "missing", policy)
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
}

func TestEgressPortReservationSurvivesVolatileDirectoryReplacement(t *testing.T) {
	ca, err := ironproxy.GenerateCA("restart", time.Hour)
	require.NoError(t, err)
	volatile, durable := t.TempDir(), t.TempDir()
	binary, err := exec.LookPath("true")
	require.NoError(t, err)
	config := EgressProxyConfig{Binary: binary, Dir: volatile, MarkerDir: durable, CA: ca, PortMin: 42300, PortMax: 42300, BindHost: "127.0.0.1"}
	before, err := NewEgressProxyManager(config)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(before.markerPath("retained"), []byte("42300\n"), 0600))
	before.procs["retained"] = &egressProxyProcess{port: 42300}
	before.StopAll()
	require.True(t, before.Required("retained"), "graceful worker shutdown must preserve the port")
	require.NoError(t, os.RemoveAll(volatile))
	after, err := NewEgressProxyManager(config)
	require.NoError(t, err)
	require.True(t, after.Required("retained"))
	_, err = after.allocatePortLocked()
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	entries, err := os.ReadDir(durable)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "retained.port", entries[0].Name())
	data, err := os.ReadFile(after.markerPath("retained"))
	require.NoError(t, err)
	assert.Equal(t, "42300\n", string(data))
}
