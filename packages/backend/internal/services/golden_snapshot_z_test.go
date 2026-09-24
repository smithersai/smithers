package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestGoldenSnapshot_Z_MarkBadStartAndRefreshBranches(t *testing.T) {
	ctx := context.Background()
	var refreshSeen sync.Once
	refreshed := make(chan struct{})
	svc := NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			if sql == latestReadyGoldenSnapshotSQL {
				refreshSeen.Do(func() { close(refreshed) })
				return fakeGoldenRow{scan: func(dest ...any) {
					*(dest[0].(*string)) = "snap-fresh"
					*(dest[1].(*time.Time)) = time.Now()
				}}
			}
			return fakeGoldenRow{err: pgx.ErrNoRows}
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.cachedID = "snap-bad"
	svc.MarkBad(ctx, "snap-bad")
	require.Eventually(t, func() bool {
		select {
		case <-refreshed:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)
	assert.Empty(t, svc.cachedID)

	oldRefreshEvery := goldenSnapshotRefreshEvery
	goldenSnapshotRefreshEvery = time.Millisecond
	t.Cleanup(func() { goldenSnapshotRefreshEvery = oldRefreshEvery })

	var calls atomic.Int32
	ctxLoop, cancelLoop := context.WithCancel(ctx)
	defer cancelLoop()
	loopSvc := NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			if sql == latestReadyGoldenSnapshotSQL {
				calls.Add(1)
				return fakeGoldenRow{scan: func(dest ...any) {
					*(dest[0].(*string)) = "snap-loop"
					*(dest[1].(*time.Time)) = time.Now()
				}}
			}
			return fakeGoldenRow{err: pgx.ErrNoRows}
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	loopSvc.Start(ctxLoop)
	require.Eventually(t, func() bool { return calls.Load() >= 2 }, time.Second, time.Millisecond)
	loopSvc.Stop()

	ctxCanceled, cancelCanceled := context.WithCancel(ctx)
	cancelCanceled()
	canceledDone := make(chan struct{})
	canceledSvc := NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			if sql == latestReadyGoldenSnapshotSQL {
				defer close(canceledDone)
				return fakeGoldenRow{scan: func(dest ...any) {
					*(dest[0].(*string)) = "snap-canceled"
					*(dest[1].(*time.Time)) = time.Now()
				}}
			}
			return fakeGoldenRow{err: pgx.ErrNoRows}
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	canceledSvc.Start(ctxCanceled)
	require.Eventually(t, func() bool {
		select {
		case <-canceledDone:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)

	refreshSvc := NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			switch sql {
			case latestReadyGoldenSnapshotSQL, reclaimStaleBakingSQL:
				return fakeGoldenRow{err: pgx.ErrNoRows}
			case insertGoldenSnapshotBakingSQL:
				return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "row-z" }}
			case finishGoldenSnapshotSQL:
				return fakeGoldenRow{err: errors.New("finish failed")}
			default:
				return fakeGoldenRow{err: pgx.ErrNoRows}
			}
		},
	}, &goldenSnapshotHVM{fakeGoldenVMClient: &fakeGoldenVMClient{}, createErr: errors.New("create failed")}, func() sandbox.CreateRequest {
		return sandbox.CreateRequest{}
	})
	refreshSvc.refresh(ctx)
}

func TestGoldenSnapshot_Z_GCReclaimAndBakeBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewGoldenSnapshotService(goldenSnapshotHDB{
		execFn: func(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
			if sql == deleteGoldenSnapshotRowSQL {
				return pgconn.CommandTag{}, errors.New("delete row failed")
			}
			return pgconn.CommandTag{}, nil
		},
		queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
			return &goldenSnapshotHRows{rows: []goldenGCRow{{id: "old", snapshotID: ""}}}, nil
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.gcSupersededSnapshots(ctx, "row-z")

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "stale-z" }}
		},
	}, nil, nil)
	svc.reclaimStaleBaking(ctx)

	ctxCanceled, cancel := context.WithCancel(ctx)
	cancel()
	svc = NewGoldenSnapshotService(nil, &fakeGoldenVMClient{execAttemptsUntilReady: 1000}, func() sandbox.CreateRequest {
		return sandbox.CreateRequest{}
	})
	_, err := svc.bake(ctxCanceled)
	require.ErrorContains(t, err, "toolchain never became ready")
}
