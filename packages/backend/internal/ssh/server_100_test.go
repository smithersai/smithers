package ssh

import (
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	stdErrors "errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type serverHAddr string

func (a serverHAddr) Network() string { return "tcp" }
func (a serverHAddr) String() string  { return string(a) }

func serverHNewPublicKey(t *testing.T) gossh.PublicKey {
	t.Helper()

	pub, _, err := ed25519.GenerateKey(cryptorand.Reader)
	require.NoError(t, err)
	key, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)
	return key
}

func serverHAPIStatus(t *testing.T, err error) int {
	t.Helper()

	require.Error(t, err)
	apiErr, ok := err.(*apierrors.APIError)
	require.True(t, ok, "expected APIError, got %T", err)
	return apiErr.Status
}

func TestServer_H_RemoteAddrIPStringAddr(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "198.51.100.44", remoteAddrIP(serverHAddr("198.51.100.44:2200")))
	assert.Equal(t, "not-a-hostport", remoteAddrIP(serverHAddr("not-a-hostport")))
}

func TestServer_H_ConnCallbackMetricsIncrementAndDecrement(t *testing.T) {
	t.Parallel()

	metrics := NewMetrics(prometheus.NewRegistry())
	server := &Server{Metrics: metrics}
	ctx, cancel := context.WithCancel(context.Background())
	conn := &testNetConn{remote: serverHAddr("198.51.100.45:2200")}

	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx), conn))
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.ActiveConns))

	cancel()
	require.Eventually(t, func() bool {
		server.connMu.Lock()
		defer server.connMu.Unlock()
		return server.activeConns == 0 && len(server.activeConnsPerIP) == 0
	}, time.Second, 10*time.Millisecond)
	assert.Equal(t, 0.0, testutil.ToFloat64(metrics.ActiveConns))
}

func TestServer_H_PublicKeyHandlerBannedAndThrottledMetrics(t *testing.T) {
	t.Parallel()

	key := serverHNewPublicKey(t)
	metrics := NewMetrics(prometheus.NewRegistry())
	now := time.Date(2026, time.January, 3, 12, 0, 0, 0, time.UTC)

	bannedLimiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 20,
		MaxAuthFailures:   1,
		InitialBan:        time.Minute,
		MaxBan:            time.Minute,
		Now: func() time.Time {
			return now
		},
	})
	bannedLimiter.RecordFailure("203.0.113.8")
	bannedServer := &Server{
		AuthLimiter: bannedLimiter,
		Metrics:     metrics,
		Queries:     &mockSSHPrincipalQuerier{},
	}
	assert.False(t, bannedServer.publicKeyHandler(newTestSSHContextWithRemoteAddr("203.0.113.8:2222"), key))

	throttledLimiter := NewAuthLimiter(AuthLimiterConfig{
		AttemptsPerMinute: 1,
		MaxAuthFailures:   5,
		InitialBan:        time.Minute,
		MaxBan:            time.Minute,
		Now: func() time.Time {
			return now
		},
	})
	assert.Equal(t, AuthLimitAllowed, throttledLimiter.Check("203.0.113.9"))
	throttledServer := &Server{
		AuthLimiter: throttledLimiter,
		Metrics:     metrics,
		Queries:     &mockSSHPrincipalQuerier{},
	}
	assert.False(t, throttledServer.publicKeyHandler(newTestSSHContextWithRemoteAddr("203.0.113.9:2222"), key))

	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("banned")))
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("throttled")))
}

func TestServer_H_PublicKeyHandlerNilQueriesRecordsFailureMetricsAndAudit(t *testing.T) {
	t.Parallel()

	key := serverHNewPublicKey(t)
	metrics := NewMetrics(prometheus.NewRegistry())
	audit := &mockSSHAuditQuerier{}
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 10,
			MaxAuthFailures:   5,
			InitialBan:        time.Minute,
			MaxBan:            time.Minute,
			Now: func() time.Time {
				return time.Date(2026, time.January, 3, 12, 30, 0, 0, time.UTC)
			},
		}),
		Metrics:      metrics,
		AuditService: services.NewAuditService(audit),
	}

	ok := server.publicKeyHandler(newTestSSHContextWithRemoteAddr("203.0.113.10:2222"), key)

	assert.False(t, ok)
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("failed")))
	require.Equal(t, 1, audit.insertCalls)
	assert.Equal(t, "ssh.auth", audit.lastInsertArg.EventType)
	assert.Equal(t, "failure", audit.lastInsertArg.Action)
	assert.Equal(t, "203.0.113.10", audit.lastInsertArg.IpAddress)
}

func TestServer_H_PublicKeyHandlerLookupErrorRecordsMetrics(t *testing.T) {
	t.Parallel()

	key := serverHNewPublicKey(t)
	metrics := NewMetrics(prometheus.NewRegistry())
	server := &Server{
		Metrics: metrics,
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				return db.GetUserBySSHFingerprintRow{}, stdErrors.New("lookup failed")
			},
		},
	}

	ok := server.publicKeyHandler(newTestSSHContextWithRemoteAddr("203.0.113.11:2222"), key)

	assert.False(t, ok)
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("failed")))
}

func TestServer_H_PublicKeyHandlerSuccessMetricsAndAudit(t *testing.T) {
	t.Parallel()

	key := serverHNewPublicKey(t)
	metrics := NewMetrics(prometheus.NewRegistry())
	audit := &mockSSHAuditQuerier{}
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 10,
			MaxAuthFailures:   5,
			InitialBan:        time.Minute,
			MaxBan:            time.Minute,
			Now: func() time.Time {
				return time.Date(2026, time.January, 3, 13, 0, 0, 0, time.UTC)
			},
		}),
		Metrics:      metrics,
		AuditService: services.NewAuditService(audit),
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				return db.GetUserBySSHFingerprintRow{UserID: 42, Username: "alice"}, nil
			},
		},
	}

	ok := server.publicKeyHandler(newTestSSHContextWithRemoteAddr("203.0.113.12:2222"), key)

	require.True(t, ok)
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.AuthAttempts.WithLabelValues("success")))
	require.Equal(t, 1, audit.insertCalls)
	assert.Equal(t, "ssh.auth", audit.lastInsertArg.EventType)
	assert.Equal(t, "success", audit.lastInsertArg.Action)
	assert.True(t, audit.lastInsertArg.ActorID.Valid)
	assert.Equal(t, int64(42), audit.lastInsertArg.ActorID.Int64)
	assert.Equal(t, "alice", audit.lastInsertArg.ActorName)
	assert.Contains(t, string(audit.lastInsertArg.Metadata), `"principal_login":"alice"`)
	assert.Contains(t, string(audit.lastInsertArg.Metadata), `"principal_type":"user"`)
	assert.Contains(t, string(audit.lastInsertArg.Metadata), `"fingerprint":"SHA256:`)
}

func TestServer_H_LookupPrincipalDeployKeyLookupError(t *testing.T) {
	t.Parallel()

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
			},
			getAnyDeployKeyByFingerprint: func(ctx context.Context, fingerprint string) (db.DeployKey, error) {
				return db.DeployKey{}, stdErrors.New("deploy key lookup failed")
			},
		},
	}

	_, err := server.lookupPrincipal(context.Background(), "SHA256:key")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "deploy key lookup failed")
}

func TestServer_H_SessionHandlerMetricsSuccessAuditPush(t *testing.T) {
	t.Parallel()

	metrics := NewMetrics(prometheus.NewRegistry())
	audit := &mockSSHAuditQuerier{}
	server := &Server{
		Metrics:      metrics,
		AuditService: services.NewAuditService(audit),
		Authorizer:   &mockSSHAuthorizer{},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}
	sess := newTestSession("git-receive-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 77, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.GitOperations.WithLabelValues("git-receive-pack", "success")))
	require.Equal(t, 1, audit.insertCalls)
	assert.Equal(t, "ssh.push", audit.lastInsertArg.EventType)
	assert.Equal(t, "repository", audit.lastInsertArg.TargetType)
	assert.Equal(t, "alice/demo", audit.lastInsertArg.TargetName)
	assert.True(t, audit.lastInsertArg.ActorID.Valid)
	assert.Equal(t, int64(77), audit.lastInsertArg.ActorID.Int64)
}

func TestServer_H_SessionHandlerMetricsError(t *testing.T) {
	t.Parallel()

	metrics := NewMetrics(prometheus.NewRegistry())
	server := &Server{
		Metrics:    metrics,
		Authorizer: &mockSSHAuthorizer{},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return nil, stdErrors.New("repo host failed")
			},
		},
	}
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 77, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Equal(t, 1.0, testutil.ToFloat64(metrics.GitOperations.WithLabelValues("git-upload-pack", "error")))
}

func TestServer_H_ResolveDeployKeyForRepoErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		repoErr    error
		keyErr     error
		wantStatus int
	}{
		{name: "repo missing", repoErr: pgx.ErrNoRows, wantStatus: 404},
		{name: "repo backend error", repoErr: stdErrors.New("repo db failed"), wantStatus: 500},
		{name: "key missing", keyErr: pgx.ErrNoRows, wantStatus: 403},
		{name: "key backend error", keyErr: stdErrors.New("key db failed"), wantStatus: 500},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			server := &Server{
				Queries: &mockSSHPrincipalQuerier{
					getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
						if tc.repoErr != nil {
							return db.Repository{}, tc.repoErr
						}
						assert.Equal(t, "alice", arg.Owner)
						assert.Equal(t, "demo", arg.LowerName)
						return db.Repository{ID: 88}, nil
					},
					getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
						assert.Equal(t, int64(88), arg.RepositoryID)
						if tc.keyErr != nil {
							return db.DeployKey{}, tc.keyErr
						}
						return db.DeployKey{}, nil
					},
				},
			}

			_, _, err := server.resolveDeployKeyForRepo(context.Background(), " alice ", "Demo ", "SHA256:key")
			assert.Equal(t, tc.wantStatus, serverHAPIStatus(t, err))
		})
	}
}

func TestServer_H_AuthorizeDeployKeyResolveArchivedAndTouchError(t *testing.T) {
	t.Parallel()

	t.Run("resolve error", func(t *testing.T) {
		t.Parallel()

		server := &Server{
			Queries: &mockSSHPrincipalQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return db.Repository{}, pgx.ErrNoRows
				},
			},
		}

		_, err := server.authorizePrincipal(context.Background(), sshPrincipal{
			Fingerprint: "SHA256:key",
			IsDeployKey: true,
		}, "alice", "demo", services.AccessModeRead)
		assert.Equal(t, 404, serverHAPIStatus(t, err))
	})

	t.Run("archived write denied", func(t *testing.T) {
		t.Parallel()

		server := &Server{
			Queries: &mockSSHPrincipalQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return db.Repository{ID: 88, IsArchived: true}, nil
				},
				getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
					return db.DeployKey{ID: 9, Title: "CI"}, nil
				},
			},
		}

		_, err := server.authorizePrincipal(context.Background(), sshPrincipal{
			Fingerprint: "SHA256:key",
			IsDeployKey: true,
		}, "alice", "demo", services.AccessModeWrite)
		assert.Equal(t, 403, serverHAPIStatus(t, err))
	})

	t.Run("touch error still allows", func(t *testing.T) {
		t.Parallel()

		server := &Server{
			Queries: &mockSSHPrincipalQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return db.Repository{ID: 88}, nil
				},
				getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
					return db.DeployKey{ID: 9, Title: "CI"}, nil
				},
				touchDeployKeyLastUsedFn: func(ctx context.Context, id int64) error {
					return stdErrors.New("touch failed")
				},
			},
		}

		principal, err := server.authorizePrincipal(context.Background(), sshPrincipal{
			Fingerprint: "SHA256:key",
			IsDeployKey: true,
		}, "alice", "demo", services.AccessModeRead)
		require.NoError(t, err)
		assert.True(t, principal.IsDeployKey)
		assert.Equal(t, "deploy-key:CI", principal.Username)
	})
}

func TestServer_H_AuditPrincipalType(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "deploy_key", sshPrincipal{IsDeployKey: true}.auditPrincipalType())
	assert.Equal(t, "user", sshPrincipal{}.auditPrincipalType())
}

func TestServer_H_ProxyUploadPackSuccessfulRequestOverLimit(t *testing.T) {
	t.Parallel()

	server := &Server{
		MaxUploadPackRequestSize: 8,
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
		},
	}
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "0009done\n")

	err := server.proxyUploadPack(context.Background(), sess, "alice", "demo")

	require.ErrorIs(t, err, errGitRequestTooLarge)
}

func TestServer_H_ListenAndServeHostKeyError(t *testing.T) {
	t.Parallel()

	hostKeyDir := filepath.Join(t.TempDir(), "not-a-directory")
	require.NoError(t, os.WriteFile(hostKeyDir, []byte("x"), 0600))
	server := &Server{
		Addr:       ":0",
		HostKeyDir: hostKeyDir,
	}

	err := server.ListenAndServe()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "ensure host key")
}

func TestServer_H_EnsureHostKeyInjectedGenerateError(t *testing.T) {
	original := hostKeyGenerateKey
	hostKeyGenerateKey = func(rand io.Reader) (ed25519.PublicKey, ed25519.PrivateKey, error) {
		return nil, nil, stdErrors.New("entropy failed")
	}
	defer func() { hostKeyGenerateKey = original }()

	_, err := ensureHostKey(filepath.Join(t.TempDir(), "ssh_host_ed25519_key"))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "generate ed25519 key")
}

func TestServer_H_EnsureHostKeyInjectedMarshalError(t *testing.T) {
	original := hostKeyMarshalPKCS8PrivateKey
	hostKeyMarshalPKCS8PrivateKey = func(key any) ([]byte, error) {
		return nil, stdErrors.New("marshal failed")
	}
	defer func() { hostKeyMarshalPKCS8PrivateKey = original }()

	_, err := ensureHostKey(filepath.Join(t.TempDir(), "ssh_host_ed25519_key"))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "marshal private key")
}

func TestServer_H_EnsureHostKeyInjectedWriteError(t *testing.T) {
	original := hostKeyWriteFile
	hostKeyWriteFile = func(name string, data []byte, perm os.FileMode) error {
		return stdErrors.New("write failed")
	}
	defer func() { hostKeyWriteFile = original }()

	_, err := ensureHostKey(filepath.Join(t.TempDir(), "ssh_host_ed25519_key"))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "write host key")
}

func TestServer_H_EnsureHostKeyInjectedParseGeneratedError(t *testing.T) {
	original := hostKeyParsePrivateKey
	hostKeyParsePrivateKey = func(pemBytes []byte) (gossh.Signer, error) {
		return nil, stdErrors.New("parse generated failed")
	}
	defer func() { hostKeyParsePrivateKey = original }()

	_, err := ensureHostKey(filepath.Join(t.TempDir(), "ssh_host_ed25519_key"))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse generated host key")
}

var _ net.Addr = serverHAddr("")
