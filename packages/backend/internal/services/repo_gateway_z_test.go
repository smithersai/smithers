package services

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
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

func (q *repoGatewayZWinnerErrQuerier) GetActiveRepoGatewayForUserRepo(context.Context, db.GetActiveRepoGatewayForUserRepoParams) (db.RepoGateway, error) {
	q.calls++
	if q.calls == 1 {
		return db.RepoGateway{}, pgx.ErrNoRows
	}
	return db.RepoGateway{}, errors.New("winner lookup failed")
}

type repoGatewayZGoldenRow struct{}

func (repoGatewayZGoldenRow) Scan(dest ...any) error {
	*(dest[0].(*string)) = "snap-1"
	*(dest[1].(*time.Time)) = time.Now().UTC()
	return nil
}

type repoGatewayZGoldenDB struct {
	execs atomic.Int32
}

func (d *repoGatewayZGoldenDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return repoGatewayZGoldenRow{}
}

func (d *repoGatewayZGoldenDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unused")
}

func (d *repoGatewayZGoldenDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	d.execs.Add(1)
	return pgconn.CommandTag{}, nil
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
	_, err := svc.reuseGateway(ctx, db.RepoGateway{ID: "gw", VmID: "vm-idle", Status: "suspended", AuthTokenCiphertext: "smithers_gateway_token"})
	require.ErrorIs(t, err, errRepoGatewayUnrecoverable)

	q := &repoGatewayHStatusErrQuerier{fakeRepoGatewayQuerier: &fakeRepoGatewayQuerier{}, softErr: errors.New("soft failed")}
	vm := &repoGatewayZVMClient{fakeRepoGatewayVMClient: &fakeRepoGatewayVMClient{}, deleteDomainErr: errors.New("unmap failed")}
	svc = newTestRepoGatewayService(q, vm, WithRepoGatewaySandboxMetrics(&mockSandboxMetricsRecorder{}))
	svc.discardGateway(ctx, db.RepoGateway{ID: "gw", VmID: "vm", Status: "running"})
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

	goldenDB := &repoGatewayZGoldenDB{}
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
	created, err := svc.createGatewayVM(ctx)
	require.NoError(t, err)
	assert.Equal(t, "vm-bare", created.ID)
	assert.Equal(t, 2, createCalls)
	assert.Equal(t, int32(1), goldenDB.execs.Load())

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

	sweepQ := &fakeRepoGatewayQuerier{staleRows: []db.RepoGateway{{ID: "gw", VmID: "vm", Status: "starting"}}}
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
