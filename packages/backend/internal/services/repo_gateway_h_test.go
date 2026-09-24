package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type repoGatewayHCodec struct {
	encryptErr error
	decryptErr error
	plaintext  string
}

func (c repoGatewayHCodec) EncryptString(plaintext string) (string, error) {
	if c.encryptErr != nil {
		return "", c.encryptErr
	}
	return "enc:" + plaintext, nil
}

func (c repoGatewayHCodec) DecryptString(ciphertext string) (string, error) {
	if c.decryptErr != nil {
		return "", c.decryptErr
	}
	if c.plaintext != "" {
		return c.plaintext, nil
	}
	return strings.TrimPrefix(ciphertext, "enc:"), nil
}

type repoGatewayHStatusErrQuerier struct {
	*fakeRepoGatewayQuerier
	statusErr error
	softErr   error
}

func (q *repoGatewayHStatusErrQuerier) UpdateRepoGatewayStatus(ctx context.Context, arg runtimeports.UpdateRepoGatewayStatusParams) (runtimeports.RepoGateway, error) {
	if q.statusErr != nil {
		return runtimeports.RepoGateway{}, q.statusErr
	}
	return q.fakeRepoGatewayQuerier.UpdateRepoGatewayStatus(ctx, arg)
}

func (q *repoGatewayHStatusErrQuerier) SoftDeleteRepoGateway(ctx context.Context, id string) (runtimeports.RepoGateway, error) {
	if q.softErr != nil {
		return runtimeports.RepoGateway{}, q.softErr
	}
	return q.fakeRepoGatewayQuerier.SoftDeleteRepoGateway(ctx, id)
}

type repoGatewayHAccessTokenErrQuerier struct {
	*fakeRepoGatewayQuerier
	createTokenErr error
	deleteTokenErr error
}

type repoGatewayHActiveSequenceQuerier struct {
	*fakeRepoGatewayQuerier
	winner      runtimeports.RepoGateway
	activeCalls int
}

func (q *repoGatewayHActiveSequenceQuerier) GetActiveRepoGatewayForUserRepo(ctx context.Context, arg runtimeports.GetActiveRepoGatewayForUserRepoParams) (runtimeports.RepoGateway, error) {
	q.activeCalls++
	if q.activeCalls == 1 {
		return runtimeports.RepoGateway{}, pgx.ErrNoRows
	}
	return q.winner, nil
}

func (q *repoGatewayHAccessTokenErrQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if q.createTokenErr != nil {
		return db.AccessToken{}, q.createTokenErr
	}
	return q.fakeRepoGatewayQuerier.CreateAccessToken(ctx, arg)
}

func (q *repoGatewayHAccessTokenErrQuerier) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	if q.deleteTokenErr != nil {
		return q.deleteTokenErr
	}
	return q.fakeRepoGatewayQuerier.DeleteAccessToken(ctx, arg)
}

func TestRepoGateway_H_ConnectionConfigAndReuseBranches(t *testing.T) {
	ctx := context.Background()

	_, err := NewRepoGatewayService(nil, WithRepoGatewaySandboxClient(&fakeRepoGatewayVMClient{})).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewRepoGatewayService(&fakeRepoGatewayQuerier{}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))

	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{})
	_, err = svc.reuseGateway(ctx, runtimeports.RepoGateway{ID: "gw", Status: "weird", AuthTokenCiphertext: "token"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q := &fakeRepoGatewayQuerier{}
	vm := &fakeRepoGatewayVMClient{}
	metricsDelta := float64(0)
	svc = newTestRepoGatewayService(q, vm,
		WithRepoGatewaySecretCodec(repoGatewayHCodec{decryptErr: errors.New("decrypt failed")}),
		WithRepoGatewaySandboxMetrics(&mockSandboxMetricsRecorder{addActiveVMsFn: func(_ string, delta float64) {
			metricsDelta += delta
		}}),
	)
	_, err = svc.reuseGateway(ctx, runtimeports.RepoGateway{ID: "gw-live", VmID: "vm-live", Status: "running", AuthTokenCiphertext: "bad"})
	require.ErrorIs(t, err, errRepoGatewayUnrecoverable)
	svc.discardGateway(ctx, runtimeports.RepoGateway{ID: "gw-live", VmID: "vm-live", Status: "running"})
	assert.Contains(t, vm.deletedVMIDs, "vm-live")
	assert.Contains(t, q.softDeleted, "gw-live")
	assert.Equal(t, float64(-1), metricsDelta)

	svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	})
	_, err = svc.reuseGateway(ctx, runtimeports.RepoGateway{ID: "gw", VmID: "vm-missing", Status: "running", AuthTokenCiphertext: "smithers_gateway_token"})
	require.ErrorIs(t, err, errRepoGatewayUnrecoverable)

	var startedWait *bool
	q = &fakeRepoGatewayQuerier{}
	svc = newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-idle", State: sandbox.StateStopped}, nil
		},
		startVMFn: func(_ context.Context, _ string, req sandbox.StartRequest) (sandbox.StartResult, error) {
			startedWait = req.WaitForReady
			return sandbox.StartResult{ID: "vm-idle"}, nil
		},
	}, WithRepoGatewaySandboxMetrics(&mockSandboxMetricsRecorder{addActiveVMsFn: func(_ string, delta float64) {
		metricsDelta += delta
	}}))
	info, err := svc.reuseGateway(ctx, runtimeports.RepoGateway{ID: "gw-idle", VmID: "vm-idle", BaseUrl: "https://gw", Status: "suspended", AuthTokenCiphertext: "smithers_gateway_token"})
	require.NoError(t, err)
	require.NotNil(t, startedWait)
	assert.False(t, *startedWait)
	assert.Equal(t, "running", info.Status)
}

func TestRepoGateway_H_ProvisionFailureAndRaceBranches(t *testing.T) {
	ctx := context.Background()

	q := &fakeRepoGatewayQuerier{createGatewayErr: errors.New("insert failed")}
	_, err := newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q = &fakeRepoGatewayQuerier{}
	_, err = newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{}, WithRepoGatewaySecretCodec(repoGatewayHCodec{encryptErr: errors.New("encrypt failed")})).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	require.NotEmpty(t, q.statusUpdates)
	assert.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)

	_, err = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, errors.New("create failed")
		},
	}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	winner := runtimeports.RepoGateway{ID: "gw-winner", VmID: "vm-winner", BaseUrl: "https://winner", Status: "running", AuthTokenCiphertext: "smithers_gateway_winner"}
	raceQ := &repoGatewayHActiveSequenceQuerier{
		fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
			executionInfoErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"},
		},
		winner: winner,
	}
	vm := &fakeRepoGatewayVMClient{}
	info, err := newTestRepoGatewayService(raceQ, vm).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.NoError(t, err)
	assert.Equal(t, "gw-winner", info.GatewayID)
	assert.Contains(t, vm.deletedVMIDs, "vm-gw-1")

	q = &fakeRepoGatewayQuerier{executionInfoErr: errors.New("persist failed")}
	vm = &fakeRepoGatewayVMClient{}
	_, err = newTestRepoGatewayService(q, vm).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Contains(t, vm.deletedVMIDs, "vm-gw-1")

	q = &fakeRepoGatewayQuerier{}
	_, err = newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{
		execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if strings.Contains(req.Command, repoGatewayRuntimeInstallScript[:20]) {
				return sandbox.ExecResult{}, errors.New("runtime transport failed")
			}
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
	}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q = &fakeRepoGatewayQuerier{}
	_, err = newTestRepoGatewayService(q, &fakeRepoGatewayVMClient{
		createSystemdServiceFn: func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			return sandbox.CreateServiceResult{}, errors.New("systemd failed")
		},
	}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	statusErrQ := &repoGatewayHStatusErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, statusErr: errors.New("status failed")}
	_, err = newTestRepoGatewayService(statusErrQ, &fakeRepoGatewayVMClient{}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestRepoGateway_H_WorkspaceCommandsConcurrencyAndReaper(t *testing.T) {
	ctx := context.Background()

	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm)
	require.NoError(t, svc.prepareGatewayWorkspace(ctx, "vm-empty", RepoGatewayConnectionInput{}))
	require.Len(t, vm.execAwaitReqs, 1)
	assert.Contains(t, vm.execAwaitReqs[0].Command, "install -d '/workspace/repo'")
	// smithers >=0.28.0 creates its own smithers.db at the gateway Workdir;
	// no seed command should remain.
	assert.NotContains(t, vm.execAwaitReqs[0].Command, "smithers.db")

	vm = &fakeRepoGatewayVMClient{}
	svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm)
	require.NoError(t, svc.prepareGatewayWorkspace(ctx, "vm-repo", testRepoGatewayInput()))
	require.Len(t, vm.execAwaitReqs, 1)
	assert.Contains(t, vm.execAwaitReqs[0].Command, "refs/remotes/origin/main")
	assert.Contains(t, vm.execAwaitReqs[0].Command, "checkout -b 'main' --track 'origin/main'")

	tokenErrQ := &repoGatewayHAccessTokenErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, createTokenErr: errors.New("token failed")}
	err := newTestRepoGatewayService(tokenErrQ, &fakeRepoGatewayVMClient{}).prepareGatewayWorkspace(ctx, "vm", testRepoGatewayInput())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	vm = &fakeRepoGatewayVMClient{}
	svc = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm)
	require.NoError(t, svc.installGatewayRuntime(ctx, "vm"))
	require.NoError(t, svc.installProductGatewayHost(ctx, "vm"))
	require.Len(t, vm.execAwaitReqs, 2)

	counter := &fakeSandboxCounter{count: 2}
	svc = NewRepoGatewayService(&fakeRepoGatewayQuerier{}, WithRepoGatewayConcurrencyCap(counter, 3))
	require.NoError(t, svc.enforceReservedProvisionConcurrency(ctx, 7))
	assert.Equal(t, 1, counter.calls)

	q := &repoGatewayHStatusErrQuerier{
		fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
			staleRows: []runtimeports.RepoGateway{
				{ID: "gw-vm", VmID: "vm-1", Status: "starting"},
				{ID: "gw-no-vm", Status: "pending"},
			},
		},
		softErr: errors.New("soft delete failed"),
	}
	vm = &fakeRepoGatewayVMClient{
		deleteVMFn: func(context.Context, string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	}
	newTestRepoGatewayService(q, vm).sweepStaleGateways(ctx)
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain("vm-1"))
	assert.Contains(t, vm.deletedVMIDs, "vm-1")
	assert.Equal(t, int64(repoGatewayStaleProvisionAge/time.Second), q.staleAgeSeconds)

	statusErrQ := &repoGatewayHStatusErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, statusErr: errors.New("status failed")}
	NewRepoGatewayService(statusErrQ).markGatewayFailed(ctx, "gw")
}
