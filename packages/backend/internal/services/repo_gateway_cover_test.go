package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type repoGatewayCovQuerier struct {
	*fakeRepoGatewayQuerier

	activeErr error
	staleErr  error
}

type repoGatewayCovGoldenDB struct{}

func (repoGatewayCovGoldenDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return repoGatewayCovRow{}
}

func (repoGatewayCovGoldenDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}

func (repoGatewayCovGoldenDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

type repoGatewayCovRow struct{}

func (repoGatewayCovRow) Scan(...any) error {
	return pgx.ErrNoRows
}

func (q *repoGatewayCovQuerier) GetActiveRepoGatewayForUserRepo(ctx context.Context, arg db.GetActiveRepoGatewayForUserRepoParams) (db.RepoGateway, error) {
	if q.activeErr != nil {
		return db.RepoGateway{}, q.activeErr
	}
	return q.fakeRepoGatewayQuerier.GetActiveRepoGatewayForUserRepo(ctx, arg)
}

func (q *repoGatewayCovQuerier) ListStaleRepoGateways(ctx context.Context, ageSeconds int64) ([]db.RepoGateway, error) {
	if q.staleErr != nil {
		return nil, q.staleErr
	}
	return q.fakeRepoGatewayQuerier.ListStaleRepoGateways(ctx, ageSeconds)
}

func TestRepoGateway_Cov_OptionsCreateVMAndEnvBranches(t *testing.T) {
	ctx := context.Background()

	t.Run("golden snapshot retry deletes orphan and preserves idle timeout", func(t *testing.T) {
		golden := NewGoldenSnapshotService(repoGatewayCovGoldenDB{}, nil, nil)
		golden.cachedID = "snap-ready"
		golden.cachedAt = time.Now()

		createCalls := 0
		vm := &fakeRepoGatewayVMClient{
			createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				createCalls++
				require.NotNil(t, req.IdleTimeoutSeconds)
				assert.Equal(t, int64(77), *req.IdleTimeoutSeconds)
				if createCalls == 1 {
					assert.Equal(t, "snap-ready", req.SnapshotID)
					return sandbox.CreateResult{ID: "vm-orphan"}, errors.New("snapshot boot failed")
				}
				assert.Empty(t, req.SnapshotID)
				return sandbox.CreateResult{ID: "vm-bare"}, nil
			},
		}
		var metricStatus string
		metrics := &mockSandboxMetricsRecorder{observeVMCreateFn: func(vmType, status string, seconds float64) {
			assert.Equal(t, "gateway", vmType)
			metricStatus = status
			assert.GreaterOrEqual(t, seconds, float64(0))
		}}
		svc := NewRepoGatewayService(&fakeRepoGatewayQuerier{},
			WithRepoGatewaySandboxClient(vm),
			WithRepoGatewayGoldenSnapshots(golden),
			WithRepoGatewayIdleTimeout(77),
			WithRepoGatewaySandboxMetrics(metrics),
		)

		svc.productHostPath = "testdata/product-gateway-fixture.mjs"
		resp, err := svc.createGatewayVM(ctx)
		require.NoError(t, err)
		assert.Equal(t, "vm-bare", resp.ID)
		assert.Equal(t, 2, createCalls)
		assert.Contains(t, vm.deletedVMIDs, "vm-orphan")
		assert.Equal(t, "success", metricStatus)
	})

	t.Run("create vm final failure records error metric", func(t *testing.T) {
		vm := &fakeRepoGatewayVMClient{
			createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{}, errors.New("api down")
			},
		}
		var metricStatus string
		svc := NewRepoGatewayService(&fakeRepoGatewayQuerier{},
			WithRepoGatewaySandboxClient(vm),
			WithRepoGatewaySandboxMetrics(&mockSandboxMetricsRecorder{observeVMCreateFn: func(_, status string, _ float64) {
				metricStatus = status
			}}),
		)

		svc.productHostPath = "testdata/product-gateway-fixture.mjs"
		_, err := svc.createGatewayVM(ctx)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Equal(t, "error", metricStatus)
	})

	t.Run("gateway env contains only runtime configuration", func(t *testing.T) {
		svc := NewRepoGatewayService(&fakeRepoGatewayQuerier{})
		env := svc.buildGatewayEnv("gateway-token")
		assert.Equal(t, "/root", env["HOME"])
		assert.Equal(t, "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin", env["PATH"])
		assert.Equal(t, "gateway-token", env["SMITHERS_API_KEY"])
		// RAM-backed /tmp guards: temp/cache land on the disk-backed /workspace.
		assert.Equal(t, "/workspace/.tmp", env["TMPDIR"])
		assert.Equal(t, "/workspace/.cache", env["XDG_CACHE_HOME"])
		assert.Len(t, env, 5)
	})
}

func TestRepoGateway_Cov_VMCommandReuseAndSystemdBranches(t *testing.T) {
	ctx := context.Background()

	t.Run("exec command includes tail detail for failing status", func(t *testing.T) {
		status := int32(2)
		longOut := strings.Repeat("x", 1100) + "tail"
		svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{StatusCode: &status, Stderr: " stderr ", Stdout: longOut}, nil
			},
		})

		err := svc.execGatewayCommand(ctx, "vm-1", "false", "run setup", time.Second)
		require.Error(t, err)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Contains(t, err.Error(), "run setup failed with status 2")
		assert.Contains(t, err.Error(), "tail")
	})

	t.Run("exec transport error and empty failure detail are mapped", func(t *testing.T) {
		svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{}, errors.New("transport failed")
			},
		})
		err := svc.execGatewayCommand(ctx, "vm-1", "cmd", "run setup", time.Second)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Contains(t, err.Error(), "transport failed")

		status := int32(7)
		svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{StatusCode: &status}, nil
			},
		})
		err = svc.execGatewayCommand(ctx, "vm-1", "cmd", "run setup", time.Second)
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Contains(t, err.Error(), "status 7")
	})

	t.Run("systemd internal error is tolerated but explicit failure is not", func(t *testing.T) {
		svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			createSystemdServiceFn: func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
				return sandbox.CreateServiceResult{}, &sandbox.StatusError{StatusCode: 500, ErrorCode: "INTERNAL_ERROR", Message: "internal"}
			},
		})
		require.NoError(t, svc.startGatewayService(ctx, "vm-1", map[string]string{"SMITHERS_API_KEY": "token"}))

		svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			createSystemdServiceFn: func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
				return sandbox.CreateServiceResult{Success: false}, nil
			},
		})
		err := svc.startGatewayService(ctx, "vm-1", map[string]string{"SMITHERS_API_KEY": "token"})
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Contains(t, err.Error(), "unknown error")
	})

	t.Run("reuse maps get and start VM non-404 failures", func(t *testing.T) {
		gateway := db.RepoGateway{ID: "gw-1", VmID: "vm-1", BaseUrl: "https://gw", AuthTokenCiphertext: "smithers_gateway_token", Status: "running"}
		svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{}, errors.New("sandbox unavailable")
			},
		})
		_, err := svc.reuseGateway(ctx, gateway)
		assert.Equal(t, 500, apiStatus(t, err))

		gateway.Status = "suspended"
		svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: "vm-1", State: sandbox.StateStopped}, nil
			},
			startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
				return sandbox.StartResult{}, errors.New("resume failed")
			},
		})
		_, err = svc.reuseGateway(ctx, gateway)
		assert.Equal(t, 500, apiStatus(t, err))
	})
}

func TestRepoGateway_Cov_ReaperConcurrencyAndHelpers(t *testing.T) {
	ctx := context.Background()

	t.Run("active query error is surfaced", func(t *testing.T) {
		q := &repoGatewayCovQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, activeErr: errors.New("select failed")}
		_, err := newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Contains(t, err.Error(), "load repo gateway")
	})

	t.Run("concurrency counter errors fail open", func(t *testing.T) {
		counter := &fakeSandboxCounter{err: errors.New("count failed")}
		svc := NewRepoGatewayService(&fakeRepoGatewayQuerier{}, WithRepoGatewayConcurrencyCap(counter, 1))
		require.NoError(t, svc.enforceReservedProvisionConcurrency(ctx, 7))
		assert.Equal(t, 1, counter.calls)
	})

	t.Run("start reaper returns for nil dependencies and cancelled context", func(t *testing.T) {
		NewRepoGatewayService(nil).StartReaper(ctx)

		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		done := make(chan struct{})
		go func() {
			newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{}).StartReaper(cancelled)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(200 * time.Millisecond):
			t.Fatal("StartReaper did not return after context cancellation")
		}
	})

	t.Run("sweep list errors are non-fatal", func(t *testing.T) {
		q := &repoGatewayCovQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, staleErr: errors.New("list failed")}
		vm := &fakeRepoGatewayVMClient{}
		newTestRepoGatewayService(q, vm).sweepStaleGateways(ctx)
		assert.Empty(t, q.softDeleted)
		assert.Empty(t, vm.deletedVMIDs)
	})

	t.Run("token hash and active unique violation detection", func(t *testing.T) {
		token, hash, err := generateRepoGatewayToken()
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(token, repoGatewayTokenPrefix))
		sum := sha256.Sum256([]byte(token))
		assert.Equal(t, hex.EncodeToString(sum[:]), hash)

		assert.False(t, isRepoGatewayActiveUniqueViolation(nil))
		assert.True(t, isRepoGatewayActiveUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"}))
		assert.False(t, isRepoGatewayActiveUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "other_unique"}))
		assert.True(t, isRepoGatewayActiveUniqueViolation(errors.New("duplicate key violates uq_repo_gateways_active")))
		assert.False(t, isRepoGatewayActiveUniqueViolation(pgx.ErrNoRows))
	})
}
