package ssh

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	stdErrors "errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	gssh "github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// errorWriter is a Session variant where Write always errors.
type errorWriteSession struct {
	*testSession
	writeErr error
}

func (s *errorWriteSession) Write(p []byte) (int, error) {
	if s.writeErr != nil {
		return 0, s.writeErr
	}
	return s.testSession.Write(p)
}

// errorReadSession replaces stdin with an erroring reader.
type errorReadSession struct {
	*testSession
	readErr error
}

func (s *errorReadSession) Read(p []byte) (int, error) {
	return 0, s.readErr
}

// --- publicKeyHandler ---

func TestPublicKeyHandler_DBError_ReturnsFalse(t *testing.T) {
	t.Parallel()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				return db.GetUserBySSHFingerprintRow{}, stdErrors.New("db connection error")
			},
		},
	}

	ctx := newTestSSHContext()
	ok := server.publicKeyHandler(ctx, sshPub)
	assert.False(t, ok)

	// Principal should not be stored in context
	value := ctx.Value(principalKey)
	assert.Nil(t, value)
}

// --- sessionHandler: AccessModeFromGitCommand error ---

func TestSessionHandler_UnknownGitCommand_DeniesAccess(t *testing.T) {
	t.Parallel()

	// git-upload-archive is a valid git command but not one smithers supports
	server := &Server{
		Authorizer:     &mockSSHAuthorizer{},
		RepoHostClient: &mockRepoHostGitProxy{},
	}

	sess := newTestSession("git-upload-archive 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "unsupported git command")
}

// --- proxyUploadPack: write ref advertisement error ---

func TestProxyUploadPack_WriteRefAdvertisementError_ReturnsError(t *testing.T) {
	t.Parallel()

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}

	inner := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess := &errorWriteSession{
		testSession: inner,
		writeErr:    stdErrors.New("ssh write error"),
	}

	err := server.proxyUploadPack(context.Background(), sess, "alice", "demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "write ref advertisement")
}

// --- proxyUploadPack: empty wants returns nil (no-op) ---

func TestProxyUploadPack_EmptyWants_ReturnsNilWithoutProxying(t *testing.T) {
	t.Parallel()

	proxyCalled := false
	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
				proxyCalled = true
				return nil
			},
		},
	}

	// stdin is empty → readGitUploadPackRequest returns empty slice
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")

	err := server.proxyUploadPack(context.Background(), sess, "alice", "demo")
	require.NoError(t, err)
	assert.False(t, proxyCalled, "should not proxy when wants are empty")
}

// --- proxyReceivePack: InfoRefsReceivePack error ---

func TestProxyReceivePack_InfoRefsError_ReturnsError(t *testing.T) {
	t.Parallel()

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return nil, stdErrors.New("repo-host unavailable")
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "")
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "fetch ref advertisement")
}

// --- proxyReceivePack: write ref advertisement error ---

func TestProxyReceivePack_WriteRefAdvertisementError_ReturnsError(t *testing.T) {
	t.Parallel()

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}

	inner := newTestSession("git-receive-pack 'alice/demo.git'", "")
	sess := &errorWriteSession{
		testSession: inner,
		writeErr:    stdErrors.New("ssh write error"),
	}
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "write ref advertisement")
}

// --- proxyReceivePack: io.Copy error from stdin ---

func TestProxyReceivePack_ReadPackDataError_ReturnsError(t *testing.T) {
	t.Parallel()

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}

	inner := newTestSession("git-receive-pack 'alice/demo.git'", "")
	// Override Write to succeed first (ref advertisement), then track writes
	sess := &errorReadSession{
		testSession: inner,
		readErr:     stdErrors.New("ssh read error"),
	}
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read receive-pack data")
}

// --- proxyReceivePack: empty pack buffer returns nil ---

func TestProxyReceivePack_EmptyPackBuffer_ReturnsNilWithoutProxying(t *testing.T) {
	t.Parallel()

	proxyCalled := false
	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				proxyCalled = true
				return nil
			},
		},
	}

	// stdin is empty → io.Copy yields 0 bytes → packBuf.Len() == 0
	sess := newTestSession("git-receive-pack 'alice/demo.git'", "")
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
	require.NoError(t, err)
	assert.False(t, proxyCalled, "should not proxy when pack buffer is empty")
}

// --- readGitUploadPackRequest: invalid pkt-line hex ---

func TestReadGitUploadPackRequest_InvalidHex_ReturnsError(t *testing.T) {
	t.Parallel()

	// "ZZZZ" is not valid hex — parser should reject it
	r := bytes.NewBufferString("ZZZZ")

	_, err := readGitUploadPackRequest(r, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid pkt-line hex")
}

// --- readGitUploadPackRequest: payload read error ---

func TestReadGitUploadPackRequest_PayloadReadError_ReturnsError(t *testing.T) {
	t.Parallel()

	// A valid pkt-line length saying 10 bytes (10 - 4 = 6 bytes payload),
	// but only provide the 4-byte length header with no payload → io.ErrUnexpectedEOF
	// but that triggers the EOF path at len header... we need partial payload.
	// "000a" = 10 → payload = 6 bytes. Provide only 2 bytes of payload.
	r := bytes.NewBufferString("000aAB")

	_, err := readGitUploadPackRequest(r, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read pkt-line payload")
}

// --- readGitUploadPackRequest: pkt-len <= 4 (minimal/flush loop) ---

func TestReadGitUploadPackRequest_PktLenFour_SkipsZeroPayload(t *testing.T) {
	t.Parallel()

	// "0004" → pktLen=4, payloadLen=0 → continue
	// Then "0009done\n" → "done\n" → stop
	r := bytes.NewBufferString("00040009done\n")

	result, err := readGitUploadPackRequest(r, nil)
	require.NoError(t, err)
	assert.Contains(t, string(result), "done\n")
}

// --- ensureHostKey: non-ErrNotExist read error ---

func TestEnsureHostKey_ReadError_NotErrNotExist_ReturnsError(t *testing.T) {
	t.Parallel()

	// Create a directory at the path where a file is expected → ReadFile will fail with EISDIR
	dir := t.TempDir()
	hostKeyPath := filepath.Join(dir, "ssh_host_ed25519_key")
	require.NoError(t, os.Mkdir(hostKeyPath, 0700))

	_, err := ensureHostKey(hostKeyPath)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read host key")
}

// --- ensureHostKey: corrupted existing key → parse error ---

func TestEnsureHostKey_CorruptedKey_ReturnsParseError(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	hostKeyPath := filepath.Join(dir, "ssh_host_ed25519_key")
	// Write garbage bytes that look like a file but are not a valid PEM key
	require.NoError(t, os.WriteFile(hostKeyPath, []byte("not a valid pem key"), 0600))

	_, err := ensureHostKey(hostKeyPath)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse host key")
}

// --- ensureHostKey: cannot write key file (read-only dir) ---

func TestEnsureHostKey_WriteError_ReturnsError(t *testing.T) {
	t.Parallel()

	if os.Getuid() == 0 {
		t.Skip("root bypasses file permission checks")
	}

	// Create a read-only directory so os.WriteFile fails
	dir := t.TempDir()
	readOnlyDir := filepath.Join(dir, "readonly")
	require.NoError(t, os.Mkdir(readOnlyDir, 0500))
	t.Cleanup(func() { _ = os.Chmod(readOnlyDir, 0700) })

	hostKeyPath := filepath.Join(readOnlyDir, "subdir", "ssh_host_ed25519_key")

	_, err := ensureHostKey(hostKeyPath)
	require.Error(t, err)
	// Either "create host key dir" or "write host key"
	assert.True(t,
		contains(err.Error(), "create host key dir") || contains(err.Error(), "write host key"),
		"expected create/write error, got: %v", err,
	)
}

// --- Interfaces ---

var _ gssh.Session = (*errorWriteSession)(nil)
var _ gssh.Session = (*errorReadSession)(nil)

// Interface assertions: errorWriteSession must delegate all Session methods.
// Since it embeds *testSession and overrides Write, all other methods come from testSession.
// These compile-time assertions verify that.

// contains is a helper for TestEnsureHostKey_WriteError_ReturnsError
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}

// errorWriteSession must satisfy gssh.Session by embedding *testSession
// and overriding Write. Verify it implements the full interface.
func TestErrorWriteSession_ImplementsSessionInterface(t *testing.T) {
	inner := newTestSession("", "")
	var _ gssh.Session = &errorWriteSession{testSession: inner}
}

func TestErrorReadSession_ImplementsSessionInterface(t *testing.T) {
	inner := newTestSession("", "")
	var _ gssh.Session = &errorReadSession{testSession: inner}
}

// errorWriteSession must proxy Context() for session handler wiring
func (s *errorWriteSession) Context() gssh.Context { return s.testSession.ctx }

// errorReadSession must proxy Context() and Write() correctly
func (s *errorReadSession) Context() gssh.Context { return s.testSession.ctx }

func (s *errorReadSession) Write(p []byte) (int, error) { return s.testSession.stdout.Write(p) }

// Stderr needs to return the inner session's stderr for assertions
func (s *errorWriteSession) Stderr() io.ReadWriter { return &s.testSession.stderr }

func (s *errorReadSession) Stderr() io.ReadWriter { return &s.testSession.stderr }

// Exit delegates to inner session for exit code tracking
func (s *errorWriteSession) Exit(code int) error {
	s.testSession.exitCode = code
	return nil
}

func (s *errorReadSession) Exit(code int) error {
	s.testSession.exitCode = code
	return nil
}

// --- proxyUploadPack: readGitUploadPackRequest error ---

// brokenReader implements io.Reader that returns some bytes then an error.
type brokenReader struct {
	data    []byte
	pos     int
	failErr error
}

func (r *brokenReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, r.failErr
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

// brokenReadSession replaces stdin with a brokenReader.
type brokenReadSession struct {
	*testSession
	reader io.Reader
}

func (s *brokenReadSession) Read(p []byte) (int, error) { return s.reader.Read(p) }
func (s *brokenReadSession) Write(p []byte) (int, error) {
	return s.testSession.stdout.Write(p)
}
func (s *brokenReadSession) Context() gssh.Context { return s.testSession.ctx }
func (s *brokenReadSession) Stderr() io.ReadWriter { return &s.testSession.stderr }
func (s *brokenReadSession) Exit(code int) error {
	s.testSession.exitCode = code
	return nil
}

var _ gssh.Session = (*brokenReadSession)(nil)

func TestProxyUploadPack_ReadRequestError_ReturnsError(t *testing.T) {
	t.Parallel()

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}

	inner := newTestSession("git-upload-pack 'alice/demo.git'", "")
	// After writing the ref advertisement, the session Read will return a non-EOF error
	// We provide 3 bytes (not 4) so io.ReadFull gets ErrUnexpectedEOF but no...
	// Actually we need a non-EOF error. Use a broken reader with exactly 3 bytes then an error.
	sess := &brokenReadSession{
		testSession: inner,
		reader: &brokenReader{
			data:    []byte("000"), // only 3 bytes, then error
			failErr: stdErrors.New("connection reset by peer"),
		},
	}

	err := server.proxyUploadPack(context.Background(), sess, "alice", "demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read upload-pack request")
}

// --- readGitUploadPackRequest: non-EOF error on pkt-len read ---

func TestReadGitUploadPackRequest_ReadLengthError_ReturnsError(t *testing.T) {
	t.Parallel()

	// Provide 3 bytes then a non-EOF/ErrUnexpectedEOF error.
	// io.ReadFull on 4 bytes will return the custom error when the reader returns an error.
	r := &brokenReader{
		data:    []byte("000"),
		failErr: stdErrors.New("connection reset by peer"),
	}

	_, err := readGitUploadPackRequest(r, nil)
	require.Error(t, err)
	// io.ReadFull wraps short-read as ErrUnexpectedEOF, which IS the EOF path
	// BUT only if len(data) < 4 and then failErr is returned for the remaining read.
	// Actually io.ReadFull: if Read returns fewer than n bytes, it tries again.
	// When data is exhausted, failErr is returned. If failErr is not EOF/ErrUnexpectedEOF,
	// io.ReadFull returns that error. Let's verify:
	// The error should be "read pkt-line length: connection reset by peer"
	assert.Contains(t, err.Error(), "read pkt-line length")
}

// Compile-time check that fmt is used (for Errorf)
var _ = fmt.Errorf
