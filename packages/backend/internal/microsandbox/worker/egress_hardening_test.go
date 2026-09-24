package worker

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/ironproxy"
	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func bareEgressManager(t *testing.T) *EgressProxyManager {
	t.Helper()
	return &EgressProxyManager{
		config:  EgressProxyConfig{Dir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		procs:   map[string]*egressProxyProcess{},
		markers: t.TempDir(),
		audit:   make(chan msb.SandboxEgressAuditRecord, 8),
	}
}

func liveProc(port int, startedAt time.Time) *egressProxyProcess {
	return &egressProxyProcess{port: port, done: make(chan struct{}), startedAt: startedAt}
}

// StartWithEgress resumes the proxy before the runtime restarts the guest,
// so a reap tick in that window sees a fresh proxy for a stopped guest. It
// used to suspend that proxy and the guest booted with no egress.
func TestReapOrphansSparesAFreshProxyForAGuestStillStarting(t *testing.T) {
	manager := bareEgressManager(t)
	manager.procs["msb_resuming"] = liveProc(42301, time.Now())
	lookup := func(context.Context, string) (sandbox.Sandbox, error) {
		return sandbox.Sandbox{ID: "msb_resuming", State: sandbox.StateStopped}, nil
	}

	stopped, suspended := manager.ReapOrphans(context.Background(), lookup)

	assert.Zero(t, stopped)
	assert.Zero(t, suspended)
	_, live := manager.Endpoint("msb_resuming")
	assert.True(t, live, "a proxy younger than the reap grace belongs to a guest still starting")
}

// ReapOrphans must act on the process it inspected. A Resume that replaced
// the proxy during the lookup must keep its new process.
func TestReapOrphansLeavesAProxyThatReplacedTheOneItSaw(t *testing.T) {
	manager := bareEgressManager(t)
	stale := liveProc(42302, time.Now().Add(-egressProxyReapGrace-time.Minute))
	fresh := liveProc(42302, time.Now())
	manager.procs["msb_replaced"] = stale
	lookup := func(context.Context, string) (sandbox.Sandbox, error) {
		manager.mu.Lock()
		manager.procs["msb_replaced"] = fresh
		manager.mu.Unlock()
		return sandbox.Sandbox{ID: "msb_replaced", State: sandbox.StateStopped}, nil
	}

	_, suspended := manager.ReapOrphans(context.Background(), lookup)

	assert.Zero(t, suspended)
	_, live := manager.Endpoint("msb_replaced")
	assert.True(t, live)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	assert.False(t, fresh.stopped, "the replacement proxy was stopped by a reap aimed at its predecessor")
}

func TestRedactCredentialShapesInJSONProxyLogs(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		`{"msg":"request","audit":{"headers":{"Authorization":"Bearer sk-live-123"}}}`: "sk-live-123",
		`{"headers":{"authorization":"Basic dXNlcjpwYXNz"}}`:                           "dXNlcjpwYXNz",
		`{"headers":{"Proxy-Authorization":["bearer tok_abc"]}}`:                       "tok_abc",
		`{"line":"authorization: Bearer\tsk-tab-456"}`:                                 "sk-tab-456",
	}
	for line, secret := range cases {
		redacted := redactCredentialShapes(line)
		assert.NotContains(t, redacted, secret, line)
		assert.Contains(t, redacted, "[redacted]", line)
	}
}

// One oversized line used to stop the relay; nothing drained the pipe after
// that and iron-proxy blocked inside its logger.
func TestRelayLogsSurvivesAnOversizedLine(t *testing.T) {
	t.Parallel()
	manager := bareEgressManager(t)
	audit := `{"time":"2026-09-02T15:00:00Z","msg":"request","audit":{"host":"example.com","method":"GET","path":"/","status":200,"allowed":true}}`
	huge := `{"msg":"request","audit":{"url":"/` + strings.Repeat("a", 2<<20) + `"}}`
	reader := strings.NewReader(huge + "\n" + audit + "\n")

	manager.relayLogs(manager.config.Logger, "msb_huge", reader)

	assert.Zero(t, reader.Len(), "the relay stopped draining the proxy's output")
	require.Len(t, manager.audit, 1, "audit records after an oversized line were lost")
	assert.Equal(t, "example.com", (<-manager.audit).Host)
}

// The final audit lines a proxy prints before exiting must be delivered by
// the time the process is reported done.
func TestEgressProxyDeliversFinalAuditLinesBeforeDone(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "iron-proxy")
	audit := `{"time":"2026-09-02T15:00:00Z","msg":"request","audit":{"host":"example.com","method":"GET","path":"/","status":200,"allowed":true}}`
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' '"+audit+"'\nexit 0\n"), 0o755))
	ca, err := ironproxy.GenerateCA("final", time.Hour)
	require.NoError(t, err)
	manager, err := NewEgressProxyManager(EgressProxyConfig{Binary: binary, Dir: dir, CA: ca, StartTimeout: 2 * time.Second, PortMin: 42400, PortMax: 42499})
	require.NoError(t, err)

	_, err = manager.Start(context.Background(), "msb_final", lifecyclePolicy())

	require.ErrorIs(t, err, ErrEgressProxyUnavailable)
	require.Len(t, manager.audit, 1, "the proxy's last audit line was lost when it exited")
}

// Stopping one sandbox's proxy waits for the child to exit. That wait must
// not hold the worker-wide lock every other sandbox needs.
func TestSuspendDoesNotBlockOtherSandboxesWhileAProxyExits(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "stubborn")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ntrap '' INT\ntouch "+filepath.Join(dir, "ready")+"\nexec sleep 30\n"), 0o755))
	manager := bareEgressManager(t)
	cmd := exec.Command(binary)
	require.NoError(t, cmd.Start())
	stubborn := liveProc(42310, time.Now())
	stubborn.cmd = cmd
	go func() { stubborn.exitErr = cmd.Wait(); close(stubborn.done) }()
	require.Eventually(t, func() bool {
		_, err := os.Stat(filepath.Join(dir, "ready"))
		return err == nil
	}, 5*time.Second, 10*time.Millisecond, "the stub never installed its SIGINT trap")
	manager.procs["msb_stubborn"] = stubborn
	manager.procs["msb_other"] = liveProc(42311, time.Now())

	suspended := make(chan struct{})
	go func() { manager.Suspend("msb_stubborn"); close(suspended) }()
	require.Eventually(t, func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return stubborn.stopped
	}, time.Second, 10*time.Millisecond)

	began := time.Now()
	_, live := manager.Endpoint("msb_other")
	assert.True(t, live)
	assert.Less(t, time.Since(began), time.Second, "Endpoint for another sandbox waited on a proxy shutdown")
	<-suspended
	<-stubborn.done
}
