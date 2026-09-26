package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type repoGatewayZVMClient struct {
	*fakeRepoGatewayVMClient
	deleteDomainErr error
}

func (v *repoGatewayZVMClient) RevokeIngress(ctx context.Context, domain string) error {
	v.unmappedDomains = append(v.unmappedDomains, domain)
	if v.deleteDomainErr != nil {
		return v.deleteDomainErr
	}
	return nil
}

type repoGatewayZWinnerErrQuerier struct {
	*fakeRepoGatewayQuerier
	calls int
}

func (q *repoGatewayZWinnerErrQuerier) GetActiveRepoGatewayForUserRepo(context.Context, runtimeports.GetActiveRepoGatewayForUserRepoParams) (runtimeports.RepoGateway, error) {
	q.calls++
	if q.calls == 1 {
		return runtimeports.RepoGateway{}, pgx.ErrNoRows
	}
	return runtimeports.RepoGateway{}, errors.New("winner lookup failed")
}

func TestRepoGateway_Z_ReuseDiscardAndProvisionCleanupBranches(t *testing.T) {
	ctx := context.Background()

	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-idle", State: sandbox.StateStopped}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	})
	_, err := svc.reuseGateway(ctx, runtimeports.RepoGateway{ID: "gw", VmID: "vm-idle", Status: "suspended", AuthTokenCiphertext: "smithers_gateway_token"})
	require.ErrorIs(t, err, errRepoGatewayUnrecoverable)

	q := &repoGatewayHStatusErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, softErr: errors.New("soft failed")}
	vm := &repoGatewayZVMClient{fakeRepoGatewayVMClient: &fakeRepoGatewayVMClient{}, deleteDomainErr: errors.New("unmap failed")}
	svc = newTestRepoGatewayService(q, vm, WithRepoGatewaySandboxMetrics(&mockSandboxMetricsRecorder{}))
	svc.discardGateway(ctx, runtimeports.RepoGateway{ID: "gw", VmID: "vm", Status: "running"})
	assert.Contains(t, vm.unmappedDomains, repoGatewayDomain("vm"))

	qBase := &fakeRepoGatewayQuerier{executionInfoErr: errors.New("persist failed")}
	_, err = newTestRepoGatewayService(qBase, &fakeRepoGatewayVMClient{
		deleteVMFn: func(context.Context, string) error { return errors.New("delete failed") },
	}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Equal(t, 500, apiStatus(t, err))

	qRace := &repoGatewayZWinnerErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{
		executionInfoErr: &pgconn.PgError{Code: "23505", ConstraintName: "uq_repo_gateways_active"},
	}}
	_, err = newTestRepoGatewayService(qRace, &fakeRepoGatewayVMClient{}).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Equal(t, 500, apiStatus(t, err))

	vmCleanup := &repoGatewayZVMClient{
		fakeRepoGatewayVMClient: &fakeRepoGatewayVMClient{
			createDomainMappingFn: func(context.Context, string, sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
				return sandbox.IngressRoute{}, errors.New("map failed")
			},
			deleteVMFn: func(context.Context, string) error { return errors.New("delete failed") },
		},
		deleteDomainErr: errors.New("unmap failed"),
	}
	_, err = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vmCleanup).GetRepoGatewayConnectionInfo(ctx, testRepoGatewayInput())
	require.Equal(t, 500, apiStatus(t, err))
}

func TestRepoGateway_Z_GoldenSnapshotWorkspaceAndReaperBranches(t *testing.T) {
	ctx := context.Background()

	goldenDB := &fakeGoldenDB{readyID: "snap-1", readyCreatedAt: time.Now()}
	golden := &GoldenSnapshotService{db: goldenDB, cachedID: "snap-1", cachedAt: time.Now()}
	createCalls := 0
	vm := &fakeRepoGatewayVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			createCalls++
			if createCalls == 1 {
				return sandbox.CreateResult{ID: "orphan"}, &sandbox.StatusError{StatusCode: 404, Message: "snapshot not found"}
			}
			return sandbox.CreateResult{ID: "vm-bare"}, nil
		},
		deleteVMFn: func(context.Context, string) error { return errors.New("delete orphan failed") },
	}
	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm, WithRepoGatewayGoldenSnapshots(golden))
	created, err := svc.createGatewayVM(ctx, nil)
	require.NoError(t, err)
	assert.Equal(t, "vm-bare", created.ID)
	assert.Equal(t, 2, createCalls)
	assert.Equal(t, []string{"snap-1"}, goldenDB.markedBadIDs)

	err = newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{}, WithRepoGatewayGitBaseURL("://bad")).prepareGatewayWorkspace(ctx, "vm", testRepoGatewayInput())
	require.Equal(t, 500, apiStatus(t, err))

	oldInterval := repoGatewayReaperIntervalDuration
	repoGatewayReaperIntervalDuration = time.Millisecond
	defer func() { repoGatewayReaperIntervalDuration = oldInterval }()
	reaperQ := &fakeRepoGatewayQuerier{}
	reaperSvc := newTestRepoGatewayService(reaperQ, &fakeRepoGatewayVMClient{})
	reaperCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		reaperSvc.StartReaper(reaperCtx)
		close(done)
	}()
	require.Eventually(t, func() bool { return reaperQ.getStaleAgeSeconds() > 0 }, time.Second, time.Millisecond)
	cancel()
	require.Eventually(t, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)

	sweepQ := &fakeRepoGatewayQuerier{staleRows: []runtimeports.RepoGateway{{ID: "gw", VmID: "vm", Status: "starting"}}}
	sweepVM := &repoGatewayZVMClient{
		fakeRepoGatewayVMClient: &fakeRepoGatewayVMClient{
			deleteVMFn: func(context.Context, string) error { return errors.New("delete failed") },
		},
		deleteDomainErr: errors.New("unmap failed"),
	}
	newTestRepoGatewayService(sweepQ, sweepVM).sweepStaleGateways(ctx)
	assert.Contains(t, sweepVM.unmappedDomains, repoGatewayDomain("vm"))
	assert.Contains(t, sweepVM.deletedVMIDs, "vm")
}
