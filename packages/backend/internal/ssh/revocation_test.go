package ssh

import (
	"bytes"
	"io"
	"testing"
	"time"

	"github.com/gliderlabs/ssh"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// fakeSession implements the slice of ssh.Session the registry touches.
type fakeSession struct {
	ssh.Session
	stderr bytes.Buffer
	exit   int
	closed bool
	ctx    ssh.Context
}

func (f *fakeSession) Stderr() io.ReadWriter { return &f.stderr }
func (f *fakeSession) Exit(code int) error   { f.exit = code; return nil }
func (f *fakeSession) Close() error          { f.closed = true; return nil }
func (f *fakeSession) Context() ssh.Context  { return f.ctx }

// fakeContext is the slice of ssh.Context sessionPrincipal reads.
type fakeContext struct {
	ssh.Context
	values map[any]any
}

func (c *fakeContext) Value(key any) any { return c.values[key] }

type fakeBus struct{ fn func(revocation.Event) }

func (b *fakeBus) Subscribe(fn func(revocation.Event)) func() {
	b.fn = fn
	return func() { b.fn = nil }
}

func TestSessionRegistry_ClosesSessionsTheEventRevokes(t *testing.T) {
	registry := &sessionRegistry{sessions: map[ssh.Session]revocation.Principal{}}
	git := &fakeSession{}
	workspace := &fakeSession{}
	other := &fakeSession{}
	registry.add(git, revocation.Principal{UserID: 7})
	registry.add(workspace, revocation.Principal{UserID: 7, SandboxID: "vm-1"})
	registry.add(other, revocation.Principal{UserID: 8, SandboxID: "vm-2"})
	require.Equal(t, 3, registry.count())

	started := time.Now()
	registry.handle(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 9, WorkspaceID: "w", SandboxIDs: []string{"vm-1"}, Reason: "share removed"})
	require.Less(t, time.Since(started), 5*time.Second)
	require.True(t, workspace.closed, "the workspace session on the revoked VM must close")
	require.Equal(t, 1, workspace.exit)
	require.Contains(t, workspace.stderr.String(), "access revoked: share removed")
	require.False(t, git.closed, "the user's git session is unrelated to the workspace share")
	require.False(t, other.closed)
	require.Equal(t, 2, registry.count())

	registry.handle(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7, Reason: "suspended"})
	require.True(t, git.closed, "a disabled user's git session must close")
	require.False(t, other.closed)
	require.Equal(t, 1, registry.count())
}

func TestSetRevocationSource_SubscribesAndReplaces(t *testing.T) {
	first := &fakeBus{}
	second := &fakeBus{}
	SetRevocationSource(first)
	require.NotNil(t, first.fn)
	SetRevocationSource(second)
	require.Nil(t, first.fn, "replacing the source must unsubscribe the old one")
	require.NotNil(t, second.fn)
	SetRevocationSource(nil)
	require.Nil(t, second.fn)
}

func TestSessionRegistry_OrgRemovalClosesNamedWorkspaceWithinBound(t *testing.T) {
	t.Parallel()
	registry := &sessionRegistry{sessions: map[ssh.Session]revocation.Principal{}}
	workspace := &fakeSession{}
	registry.add(workspace, revocation.Principal{SandboxID: "vm-org-member"})

	started := time.Now()
	registry.handle(revocation.Event{
		Kind:       revocation.KindOrgMemberRemoved,
		UserID:     7,
		SandboxIDs: []string{"vm-org-member"},
		Reason:     "organization membership removed",
	})
	require.Less(t, time.Since(started), 5*time.Second)
	require.True(t, workspace.closed)
	require.Equal(t, 1, workspace.exit)
	require.Contains(t, workspace.stderr.String(), "organization membership removed")
}

func TestSessionPrincipal_ReadsKeyUserAndWorkspaceSandbox(t *testing.T) {
	ctx := &fakeContext{values: map[any]any{
		principalKey:       sshPrincipal{UserID: 11, Username: "u"},
		workspaceAccessKey: WorkspaceAccess{SandboxID: "vm-9", User: "smithers"},
	}}
	principal := sessionPrincipal(&fakeSession{ctx: ctx})
	require.Equal(t, int64(11), principal.UserID)
	require.Equal(t, "vm-9", principal.SandboxID)

	deploy := &fakeContext{values: map[any]any{principalKey: sshPrincipal{UserID: 12, IsDeployKey: true}}}
	require.Equal(t, int64(0), sessionPrincipal(&fakeSession{ctx: deploy}).UserID, "deploy keys are not user principals")
}
