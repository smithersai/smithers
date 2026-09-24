package ssh

// Tests for workspace SSH session behaviour: the lifetime cap that replaces
// the git 2h cap once workspace auth succeeds, server-side keepalives that
// keep a silent long command off the idle reaper, and the sftp subsystem
// relay for workspace sessions only.

import (
	"context"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gssh "github.com/gliderlabs/ssh"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

type deadlineRecorder struct {
	net.Conn
	mu        sync.Mutex
	deadlines []time.Time
}

func (r *deadlineRecorder) SetDeadline(t time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deadlines = append(r.deadlines, t)
	return nil
}

func (r *deadlineRecorder) last() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deadlines[len(r.deadlines)-1]
}

func TestWorkspaceDeadlineConn_GitKeepsServerDeadline(t *testing.T) {
	t.Parallel()

	inner := &deadlineRecorder{}
	ctx := newTestSSHContext()
	conn := &workspaceDeadlineConn{Conn: inner, ctx: ctx, idleTimeout: 11 * time.Minute, maxDeadline: time.Now().Add(24 * time.Hour)}

	want := time.Now().Add(2 * time.Hour)
	require.NoError(t, conn.SetDeadline(want))
	assert.Equal(t, want, inner.last(), "a git connection must keep gliderlabs' own deadline")
}

func TestWorkspaceDeadlineConn_WorkspaceIgnoresGitLifetimeCap(t *testing.T) {
	t.Parallel()

	inner := &deadlineRecorder{}
	ctx := newTestSSHContext()
	ctx.SetValue(workspaceAccessKey, WorkspaceAccess{SandboxID: "msb_x", User: "developer"})
	conn := &workspaceDeadlineConn{Conn: inner, ctx: ctx, idleTimeout: 11 * time.Minute, maxDeadline: time.Now().Add(24 * time.Hour)}

	expired := time.Now().Add(-time.Second) // what serverConn sends once the 2h maxDeadline has passed
	require.NoError(t, conn.SetDeadline(expired))
	got := inner.last()
	assert.WithinDuration(t, time.Now().Add(11*time.Minute), got, 2*time.Second,
		"a workspace connection gets a fresh idle deadline on every activity, never the git lifetime cap")

	require.NoError(t, conn.SetDeadline(time.Time{}))
	assert.True(t, inner.last().IsZero(), "clearing the deadline passes through")
}

func TestWorkspaceDeadlineConn_WorkspaceLifetimeCapWins(t *testing.T) {
	t.Parallel()

	inner := &deadlineRecorder{}
	ctx := newTestSSHContext()
	ctx.SetValue(workspaceAccessKey, WorkspaceAccess{SandboxID: "msb_x", User: "developer"})
	capAt := time.Now().Add(time.Minute)
	conn := &workspaceDeadlineConn{Conn: inner, ctx: ctx, idleTimeout: 11 * time.Minute, maxDeadline: capAt}

	require.NoError(t, conn.SetDeadline(time.Now().Add(2*time.Hour)))
	assert.Equal(t, capAt, inner.last())

	unlimited := &workspaceDeadlineConn{Conn: inner, ctx: ctx, idleTimeout: 11 * time.Minute}
	require.NoError(t, unlimited.SetDeadline(time.Now()))
	assert.WithinDuration(t, time.Now().Add(11*time.Minute), inner.last(), 2*time.Second)
}

func TestServer_WorkspaceMaxTimeout(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultWorkspaceMaxTimeout, (&Server{}).workspaceMaxTimeout())
	assert.Equal(t, 36*time.Hour, (&Server{WorkspaceMaxTimeout: 36 * time.Hour}).workspaceMaxTimeout())
	assert.Equal(t, UnlimitedWorkspaceLifetime, (&Server{WorkspaceMaxTimeout: UnlimitedWorkspaceLifetime}).workspaceMaxTimeout())
	assert.True(t, (&Server{WorkspaceMaxTimeout: UnlimitedWorkspaceLifetime}).workspaceMaxDeadline(time.Now()).IsZero())
	now := time.Now()
	assert.Equal(t, now.Add(defaultWorkspaceMaxTimeout), (&Server{}).workspaceMaxDeadline(now))
}

type countingSender struct{ sent atomic.Int32 }

func (c *countingSender) SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error) {
	if name == "keepalive@openssh.com" {
		c.sent.Add(1)
	}
	return true, nil, nil
}

func TestStartWorkspaceKeepalive_TicksUntilStopped(t *testing.T) {
	t.Parallel()

	sender := &countingSender{}
	stop := startWorkspaceKeepalive(context.Background(), sender, 5*time.Millisecond)
	require.Eventually(t, func() bool { return sender.sent.Load() >= 3 }, time.Second, time.Millisecond)
	stop()
	settled := sender.sent.Load()
	time.Sleep(30 * time.Millisecond)
	assert.LessOrEqual(t, sender.sent.Load(), settled+1, "keepalives stop once the session ends")
}

func TestSessionHandler_RefusesSubsystemForGitPrincipals(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("", "")
	sess.subsystem = "sftp"
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "only available on workspace sessions")
}

// recordingBridge admits every login and records what the gateway asked it
// to serve.
type recordingBridge struct {
	mu        sync.Mutex
	subsystem string
	command   string
	served    chan struct{}
}

func (b *recordingBridge) Validate(context.Context, WorkspaceAccess) error { return nil }

func (b *recordingBridge) Serve(session gssh.Session, _ WorkspaceAccess) (int, error) {
	b.mu.Lock()
	b.subsystem = session.Subsystem()
	b.command = session.RawCommand()
	b.mu.Unlock()
	close(b.served)
	return 0, nil
}

func freePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	return addr
}

func TestGateway_RelaysSFTPSubsystemForWorkspaceSessions(t *testing.T) {
	t.Parallel()

	bridge := &recordingBridge{served: make(chan struct{})}
	addr := freePort(t)
	server := &Server{Addr: addr, HostKeyDir: t.TempDir(), WorkspaceBridge: bridge}
	go func() { _ = server.ListenAndServe() }()
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })

	token := strings.Repeat("a", 32)
	config := &gossh.ClientConfig{
		User:            "msb_test+developer",
		Auth:            []gossh.AuthMethod{gossh.Password(token)},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}
	var client *gossh.Client
	require.Eventually(t, func() bool {
		var err error
		client, err = gossh.Dial("tcp", addr, config)
		return err == nil
	}, 5*time.Second, 50*time.Millisecond)
	defer client.Close()

	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	require.NoError(t, session.RequestSubsystem("sftp"), "the gateway must accept the sftp subsystem for a workspace session")

	select {
	case <-bridge.served:
	case <-time.After(5 * time.Second):
		t.Fatal("bridge was never asked to serve the session")
	}
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	assert.Equal(t, "sftp", bridge.subsystem)
	assert.Equal(t, "", bridge.command)
}
