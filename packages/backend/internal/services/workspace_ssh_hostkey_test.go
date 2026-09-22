package services

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// writeEd25519HostKey generates a fresh ed25519 private key and writes it to
// path in the same OpenSSH-compatible PEM format the SSH server expects
// (internal/ssh/server.go:ensureHostKey). It returns the signer so the
// test can assert against its public half.
func writeEd25519HostKey(t *testing.T, path string) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	require.NoError(t, err)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	require.NoError(t, os.WriteFile(path, pemBytes, 0o600))
	signer, err := gossh.ParsePrivateKey(pemBytes)
	require.NoError(t, err)
	return signer
}

// Verifies the disk loader reads the primary host key and surfaces the
// correct wire-format + fingerprint. This is the trust anchor the API
// publishes to the terminal client.
func TestDiskHostKeyLoader_LoadsPrimaryKey(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	signer := writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))

	loader := NewDiskHostKeyLoader(dir)
	keys, err := loader.LoadHostKeys()
	require.NoError(t, err)
	require.Len(t, keys, 1, "no rotation companion -> exactly one key")

	assert.Equal(t, "ssh-ed25519", keys[0].Algorithm)
	assert.Equal(t,
		base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()),
		keys[0].PublicKey,
	)
	assert.Equal(t, gossh.FingerprintSHA256(signer.PublicKey()), keys[0].FingerprintSHA256)
	assert.True(t, strings.HasPrefix(keys[0].KnownHostsLine, "ssh-ed25519 "), "known_hosts line must be OpenSSH-formatted")
}

// Verifies rotation: when both primary and `.next` files exist, both
// are advertised, in priority order.
func TestDiskHostKeyLoader_IncludesNextKeyForRotation(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	primary := writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))
	next := writeEd25519HostKey(t, filepath.Join(dir, nextHostKeyFile))

	loader := NewDiskHostKeyLoader(dir)
	keys, err := loader.LoadHostKeys()
	require.NoError(t, err)
	require.Len(t, keys, 2, "primary + next during rotation")

	assert.Equal(t, gossh.FingerprintSHA256(primary.PublicKey()), keys[0].FingerprintSHA256, "primary ranks first")
	assert.Equal(t, gossh.FingerprintSHA256(next.PublicKey()), keys[1].FingerprintSHA256, "next ranks second")
}

// A stale `.next` file identical to the primary must not produce a
// duplicate — otherwise operators who forget to clean up the rotation
// artifact would pay no cost, and the trust set would silently imply
// "rotation in progress" forever.
func TestDiskHostKeyLoader_DeduplicatesIdenticalNextKey(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	signer := writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))
	// Copy primary bytes to .next.
	primaryBytes, err := os.ReadFile(filepath.Join(dir, primaryHostKeyFile))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, nextHostKeyFile), primaryBytes, 0o600))

	loader := NewDiskHostKeyLoader(dir)
	keys, err := loader.LoadHostKeys()
	require.NoError(t, err)
	require.Len(t, keys, 1, "duplicate next key must be folded into primary")
	assert.Equal(t, gossh.FingerprintSHA256(signer.PublicKey()), keys[0].FingerprintSHA256)
}

// Missing primary host key: fail closed. We must never paper over an
// empty host-key trust anchor.
func TestDiskHostKeyLoader_MissingPrimaryIsError(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	loader := NewDiskHostKeyLoader(dir)
	_, err := loader.LoadHostKeys()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "primary host key")
}

func TestDiskHostKeyLoader_PublicKnownHostsLine(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	signer := writeEd25519HostKey(t, filepath.Join(dir, "source_key"))
	knownHostsLine := "vm-ssh.sandbox.sh " + strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey())))
	require.NoError(t, os.WriteFile(filepath.Join(dir, primaryHostKeyFile), []byte(knownHostsLine+"\n"), 0o644))

	keys, err := NewDiskHostKeyLoader(dir).LoadHostKeys()
	require.NoError(t, err)
	require.Len(t, keys, 1)
	assert.Equal(t, gossh.FingerprintSHA256(signer.PublicKey()), keys[0].FingerprintSHA256)
}

// End-to-end: GetWorkspaceSSHConnectionInfo returns HostKeys populated
// from the injected loader, with at least one entry for the pinned
// server identity.
func TestWorkspaceService_GetWorkspaceSSHConnectionInfo_PopulatesHostKeys(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	// Synthesize two host keys — current + rotation candidate.
	dir := t.TempDir()
	primary := writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))
	next := writeEd25519HostKey(t, filepath.Join(dir, nextHostKeyFile))

	q := &mockWorkspaceQuerier{
		getWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-ssh-hk"
			return workspace, nil
		},
		createSandboxAccessTokenFn: func(ctx context.Context, arg clusterdb.CreateSandboxAccessTokenParams) (clusterdb.SandboxAccessToken, error) {
			return clusterdb.SandboxAccessToken{ID: "sat", VmID: arg.VmID}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
		}),
		WithWorkspaceSSHHostKeyDir(dir),
	)

	info, err := svc.GetWorkspaceSSHConnectionInfo(context.Background(), wsID, 101, 1)
	require.NoError(t, err)
	require.Len(t, info.HostKeys, 2, "both primary and next keys must be advertised during rotation")

	// Fingerprints line up with what the loader produced off-disk.
	assert.Equal(t, gossh.FingerprintSHA256(primary.PublicKey()), info.HostKeys[0].FingerprintSHA256)
	assert.Equal(t, gossh.FingerprintSHA256(next.PublicKey()), info.HostKeys[1].FingerprintSHA256)
	for _, hk := range info.HostKeys {
		assert.Equal(t, "ssh-ed25519", hk.Algorithm)
		assert.NotEmpty(t, hk.PublicKey, "raw public_key must be present for byte-wise client verification")
	}
}

// Session-level SSH info must carry the same host-key trust anchors as the
// workspace-level path. This protects reconnect flows that call
// GetSSHConnectionInfo directly.
func TestWorkspaceService_GetSSHConnectionInfo_PopulatesHostKeys(t *testing.T) {
	t.Parallel()

	const (
		wsID      = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
		sessionID = "sess-hostkeys-1"
	)

	dir := t.TempDir()
	primary := writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))
	next := writeEd25519HostKey(t, filepath.Join(dir, nextHostKeyFile))

	var persisted json.RawMessage
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionForUserRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionForUserRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{
				ID:           arg.ID,
				WorkspaceID:  wsID,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				Status:       "running",
				Cols:         120,
				Rows:         40,
			}, nil
		},
		getWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-ssh-hostkey-session"
			return workspace, nil
		},
		updateWorkspaceSessionSSHConnectionFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error) {
			persisted = arg.SshConnectionInfo
			return db.WorkspaceSession{
				ID:                arg.ID,
				WorkspaceID:       wsID,
				RepositoryID:      101,
				UserID:            1,
				Status:            "running",
				SshConnectionInfo: arg.SshConnectionInfo,
			}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
		}),
		WithWorkspaceSSHHostKeyDir(dir),
	)

	info, err := svc.GetSSHConnectionInfo(context.Background(), sessionID, 101, 1)
	require.NoError(t, err)
	require.Len(t, info.HostKeys, 2, "session ssh info must advertise primary+next host keys during rotation")
	assert.Equal(t, gossh.FingerprintSHA256(primary.PublicKey()), info.HostKeys[0].FingerprintSHA256)
	assert.Equal(t, gossh.FingerprintSHA256(next.PublicKey()), info.HostKeys[1].FingerprintSHA256)

	var stored PersistedWorkspaceSSHConnectionInfo
	require.NotEmpty(t, persisted)
	require.NoError(t, json.Unmarshal(persisted, &stored))
	require.Len(t, stored.HostKeys, 2, "persisted ssh_connection_info must keep host_keys for reconnect verification")
	assert.Equal(t, info.HostKeys[0].FingerprintSHA256, stored.HostKeys[0].FingerprintSHA256)
	assert.Equal(t, info.HostKeys[1].FingerprintSHA256, stored.HostKeys[1].FingerprintSHA256)
}

// stubHostKeyLoader lets tests drive LoadHostKeys without touching disk.
type stubHostKeyLoader struct {
	keys []WorkspaceSSHHostKey
	err  error
}

func (s *stubHostKeyLoader) LoadHostKeys() ([]WorkspaceSSHHostKey, error) {
	return s.keys, s.err
}

// Loader errors must surface as service errors, not silent fall-through
// to empty host_keys.
func TestWorkspaceService_GetWorkspaceSSHConnectionInfo_HostKeyLoaderError(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	q := &mockWorkspaceQuerier{
		getWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
			return sampleDBWorkspace(arg.ID), nil
		},
	}
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
		}),
		WithWorkspaceSSHHostKeyLoader(&stubHostKeyLoader{err: assertErr("disk unreadable")}),
	)

	_, err := svc.GetWorkspaceSSHConnectionInfo(context.Background(), wsID, 101, 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load ssh host keys")
}

// assertErr is a tiny helper so the test above can build a sentinel
// error without pulling in an extra package.
type assertErr string

func (e assertErr) Error() string { return string(e) }
