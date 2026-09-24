package worker

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// fakeProxyBinary records its pid and never listens, standing in for an
// iron-proxy child whose lifetime the test must observe.
func fakeProxyBinary(t *testing.T) (binary, pidFile string) {
	t.Helper()
	dir := t.TempDir()
	pidFile = filepath.Join(dir, "pid")
	binary = filepath.Join(dir, "iron-proxy")
	script := "#!/bin/sh\necho $$ > " + pidFile + "\nexec sleep 30\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return binary, pidFile
}

func fakeProxyManager(t *testing.T, binary string) *EgressProxyManager {
	t.Helper()
	ca, err := ironproxy.GenerateCA("lifecycle", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{
		Binary: binary, Dir: t.TempDir(), CA: ca, StartTimeout: 2 * time.Second, PortMin: 42300, PortMax: 42399,
	})
	require.NoError(t, err)
	t.Cleanup(manager.StopAll)
	return manager
}

func lifecyclePolicy() *sandbox.EgressProxyPolicy {
	return &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
		Name: "K", Value: "v", Hosts: []string{"example.test"}, MatchHeaders: []string{"authorization"},
	}}}
}

func requireNoLiveChild(t *testing.T, pidFile string) {
	t.Helper()
	time.Sleep(300 * time.Millisecond)
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return // the child never ran far enough to record itself
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	require.NoError(t, err)
	alive := syscall.Kill(pid, 0) == nil
	if alive {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	require.False(t, alive, "an untracked proxy child outlived its start")
}

// A Stop landing between the port reservation and the child start used to
// drop the reservation while spawn went on to start an untracked process
// holding the secret values in its environment.
func TestEgressProxyStopDuringStartLeavesNoChild(t *testing.T) {
	binary, pidFile := fakeProxyBinary(t)
	manager := fakeProxyManager(t, binary)
	manager.beforeSpawn = func(sandboxID string) { manager.Stop(sandboxID) }

	_, err := manager.Start(context.Background(), "msb_race", lifecyclePolicy())
	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	_, live := manager.Endpoint("msb_race")
	require.False(t, live)
	require.False(t, manager.Required("msb_race"))
	requireNoLiveChild(t, pidFile)
}

// A create that can never boot must fail before any proxy child receives
// the secret values.
func TestCreateWithoutImageStartsNoEgressProxy(t *testing.T) {
	binary, pidFile := fakeProxyBinary(t)
	manager := fakeProxyManager(t, binary)
	runtime := NewSDKRuntime(WithEgressProxyManager(manager))

	_, err := runtime.Create(context.Background(), "msb_noimage", 1, sandbox.CreateRequest{EgressProxy: lifecyclePolicy()})
	require.ErrorContains(t, err, "Microsandbox image is required")
	_, statErr := os.Stat(pidFile)
	require.True(t, os.IsNotExist(statErr), "the proxy child was spawned for an unbootable request")
	_, live := manager.Endpoint("msb_noimage")
	require.False(t, live)
	requireNoLiveChild(t, pidFile)
}
