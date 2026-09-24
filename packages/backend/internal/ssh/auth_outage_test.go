package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"

	gssh "github.com/gliderlabs/ssh"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

const outageTestToken = "abcdefghijklmnopqrstuvwxyz012345"

type authTestContext struct {
	*testSSHContext
	user string
}

func (c *authTestContext) User() string { return c.user }

func newAuthTestContext(remoteAddr, user string) *authTestContext {
	return &authTestContext{testSSHContext: newTestSSHContextWithRemoteAddr(remoteAddr), user: user}
}

type stubWorkspaceBridge struct {
	err   error
	calls int
}

func (b *stubWorkspaceBridge) Validate(context.Context, WorkspaceAccess) error {
	b.calls++
	return b.err
}

func (*stubWorkspaceBridge) Serve(gssh.Session, WorkspaceAccess) (int, error) {
	return 1, errors.New("serve must not be reached for an unavailable workspace")
}

func outageTestKey(t *testing.T) (gossh.PublicKey, string) {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	key, err := gossh.NewPublicKey(public)
	require.NoError(t, err)
	hash := sha256.Sum256(key.Marshal())
	return key, "SHA256:" + base64.RawStdEncoding.EncodeToString(hash[:])
}

// strictLimiter bans on the first recorded failure, so any wrongly recorded
// workspace fault shows up as a denied follow-up attempt.
func strictLimiter() *AuthLimiter {
	return NewAuthLimiter(AuthLimiterConfig{AttemptsPerMinute: 1000, MaxAuthFailures: 1, InitialBan: time.Hour, MaxBan: time.Hour})
}

func knownUserQuerier(fingerprints ...string) *mockSSHPrincipalQuerier {
	known := map[string]bool{}
	for _, fingerprint := range fingerprints {
		known[fingerprint] = true
	}
	return &mockSSHPrincipalQuerier{
		getUserBySSHFingerprintFn: func(_ context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
			if known[fingerprint] {
				return db.GetUserBySSHFingerprintRow{UserID: 7, Username: "alice"}, nil
			}
			return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
		},
		getAnyDeployKeyByFingerprint: func(context.Context, string) (db.DeployKey, error) {
			return db.DeployKey{}, pgx.ErrNoRows
		},
	}
}

func TestPublicKeyHandler_WorkspaceFaultsNeverBan(t *testing.T) {
	for _, validateErr := range []error{
		ErrWorkspaceUnavailable,
		fmt.Errorf("%w: controller returned HTTP 404", ErrWorkspaceUnavailable),
		errors.New("dial tcp: connection refused"),
		ErrWorkspaceAccessDenied, // the controller's 403 also means "VM deleted or re-placed"
	} {
		key, fingerprint := outageTestKey(t)
		limiter := strictLimiter()
		bridge := &stubWorkspaceBridge{err: validateErr}
		server := &Server{AuthLimiter: limiter, WorkspaceBridge: bridge, Queries: knownUserQuerier(fingerprint)}
		for attempt := range 10 {
			ctx := newAuthTestContext("76.21.33.72:2222", "msb_test+developer:"+outageTestToken)
			require.True(t, server.publicKeyHandler(ctx, key), "%v attempt %d", validateErr, attempt)
			assert.ErrorIs(t, ctx.Value(workspaceErrorKey).(error), unwrapKind(validateErr))
		}
		assert.Equal(t, 10, bridge.calls)
		assert.Equal(t, AuthLimitAllowed, limiter.Check("76.21.33.72", "key:"+fingerprint))
	}
}

func unwrapKind(err error) error {
	if errors.Is(err, ErrWorkspaceAccessDenied) {
		return ErrWorkspaceAccessDenied
	}
	return ErrWorkspaceUnavailable
}

func TestPasswordHandler_WorkspaceFaultsNeverBan(t *testing.T) {
	for _, validateErr := range []error{ErrWorkspaceUnavailable, ErrWorkspaceAccessDenied} {
		limiter := strictLimiter()
		server := &Server{AuthLimiter: limiter, WorkspaceBridge: &stubWorkspaceBridge{err: validateErr}}
		for range 10 {
			ctx := newAuthTestContext("10.0.0.7:4000", "msb_test+developer")
			// An outage is admitted so the session can say "retry"; a refusal is not.
			assert.Equal(t, errors.Is(validateErr, ErrWorkspaceUnavailable), server.passwordHandler(ctx, outageTestToken))
		}
		server.WorkspaceBridge = &stubWorkspaceBridge{}
		assert.True(t, server.passwordHandler(newAuthTestContext("10.0.0.7:4000", "msb_test+developer"), outageTestToken),
			"a healthy workspace must be reachable right after %v", validateErr)
	}
}

func TestSessionHandler_ExplainsWorkspaceFault(t *testing.T) {
	for validateErr, want := range map[error]string{
		fmt.Errorf("%w: HTTP 503", ErrWorkspaceUnavailable): "ERROR: workspace unavailable, retry",
		ErrWorkspaceAccessDenied:                            "ERROR: workspace access denied or expired",
	} {
		sess := newTestSession("", "")
		sess.ctx.SetValue(workspaceAccessKey, WorkspaceAccess{SandboxID: "msb_test", User: "developer"})
		sess.ctx.SetValue(workspaceErrorKey, validateErr)
		(&Server{WorkspaceBridge: &stubWorkspaceBridge{}}).sessionHandler(sess)
		assert.Equal(t, 1, sess.exitCode)
		assert.Contains(t, sess.stderr.String(), want)
	}
}

func TestPublicKeyHandler_BanIsolatedPerCredentialBehindSharedIP(t *testing.T) {
	deployKey, deployFingerprint := outageTestKey(t)
	userKey, userFingerprint := outageTestKey(t)
	querier := knownUserQuerier(userFingerprint)
	querier.getUserBySSHFingerprintFn = func(_ context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
		if fingerprint == userFingerprint {
			return db.GetUserBySSHFingerprintRow{UserID: 7, Username: "alice"}, nil
		}
		return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
	}
	querier.getAnyDeployKeyByFingerprint = func(_ context.Context, fingerprint string) (db.DeployKey, error) {
		if fingerprint == deployFingerprint {
			return db.DeployKey{ID: 1}, nil
		}
		return db.DeployKey{}, pgx.ErrNoRows
	}
	server := &Server{
		AuthLimiter:     NewAuthLimiter(AuthLimiterConfig{AttemptsPerMinute: 100, MaxAuthFailures: 5}),
		WorkspaceBridge: &stubWorkspaceBridge{},
		Queries:         querier,
	}
	nodeIP := "10.0.0.12"
	workspaceLogin := "msb_test+developer:" + outageTestToken

	// A deploy key used for a workspace shell is a genuine credential failure.
	for range 5 {
		assert.False(t, server.publicKeyHandler(newAuthTestContext(nodeIP+":1000", workspaceLogin), deployKey))
	}
	assert.Equal(t, AuthLimitBanned, server.AuthLimiter.Check(nodeIP, "key:"+deployFingerprint))

	// Another user behind the same SNAT address is unaffected.
	assert.True(t, server.publicKeyHandler(newAuthTestContext(nodeIP+":2000", workspaceLogin), userKey))
}

func TestAuthLimiter_IPThrottleIsLooserThanCredentialThrottle(t *testing.T) {
	limiter := NewAuthLimiter(AuthLimiterConfig{AttemptsPerMinute: 2, IPAttemptsPerMinute: 5})
	assert.Equal(t, AuthLimitAllowed, limiter.Check("10.0.0.1", "key:a"))
	assert.Equal(t, AuthLimitAllowed, limiter.Check("10.0.0.1", "key:a"))
	assert.Equal(t, AuthLimitThrottled, limiter.Check("10.0.0.1", "key:a"))
	assert.Equal(t, AuthLimitAllowed, limiter.Check("10.0.0.1", "key:b"))
	assert.Equal(t, AuthLimitAllowed, limiter.Check("10.0.0.1", "key:b"))
	assert.Equal(t, AuthLimitThrottled, limiter.Check("10.0.0.1", "key:c"), "per-IP ceiling still bounds a flood")

	assert.Equal(t, defaultAuthIPAttemptsPerMinute, NewDefaultAuthLimiter().ipAttemptsPerMinute)
	assert.GreaterOrEqual(t, defaultAuthIPAttemptsPerMinute, 25*defaultAuthAttemptsPerMinute)
}
