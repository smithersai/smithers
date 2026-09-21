package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type goldenSnapshotCovFinish struct {
	status     string
	snapshotID string
}

type goldenSnapshotCovDB struct {
	mu           sync.Mutex
	readyID      string
	readyCreated time.Time
	claimGranted bool
	reclaimCalls int
	finished     []goldenSnapshotCovFinish
	supersede    int
	markedBadIDs []string
}

func (d *goldenSnapshotCovDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch sql {
	case supersedeGoldenSnapshotsSQL:
		d.supersede++
	case markBadGoldenSnapshotSQL:
		d.markedBadIDs = append(d.markedBadIDs, args[1].(string))
	}
	return pgconn.CommandTag{}, nil
}

func (d *goldenSnapshotCovDB) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	return &fakeGoldenRows{}, nil
}

func (d *goldenSnapshotCovDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch sql {
	case latestReadyGoldenSnapshotSQL:
		if d.readyID == "" {
			return fakeGoldenRow{err: pgx.ErrNoRows}
		}
		readyID := d.readyID
		readyCreated := d.readyCreated
		return fakeGoldenRow{scan: func(dest ...any) {
			*(dest[0].(*string)) = readyID
			*(dest[1].(*time.Time)) = readyCreated
		}}
	case reclaimStaleBakingSQL:
		d.reclaimCalls++
		return fakeGoldenRow{err: pgx.ErrNoRows}
	case insertGoldenSnapshotBakingSQL:
		if !d.claimGranted {
			return fakeGoldenRow{err: pgx.ErrNoRows}
		}
		return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "row-1" }}
	case finishGoldenSnapshotSQL:
		d.finished = append(d.finished, goldenSnapshotCovFinish{
			status:     args[1].(string),
			snapshotID: args[2].(string),
		})
		return fakeGoldenRow{scan: func(dest ...any) { *(dest[0].(*string)) = "row-1" }}
	}
	return fakeGoldenRow{err: pgx.ErrNoRows}
}

func (d *goldenSnapshotCovDB) finishedCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.finished)
}

func (d *goldenSnapshotCovDB) finishAt(index int) goldenSnapshotCovFinish {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.finished[index]
}

func (d *goldenSnapshotCovDB) reclaimCallCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.reclaimCalls
}

func (d *goldenSnapshotCovDB) supersedeCallCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.supersede
}

func (d *goldenSnapshotCovDB) markedBadIDsSnapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.markedBadIDs...)
}

func TestGoldenSnapshot_Cov_StartStopAndBakeFailureBranches(t *testing.T) {
	db := &goldenSnapshotCovDB{claimGranted: true}
	vm := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: "snap-start"}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest {
		return sandbox.CreateRequest{Workdir: "/workspace"}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.Start(ctx)
	svc.Start(ctx)

	require.Eventually(t, func() bool {
		return db.finishedCount() == 1
	}, time.Second, 10*time.Millisecond)
	svc.Stop()
	svc.Stop()

	finished := db.finishAt(0)
	assert.Equal(t, "ready", finished.status)
	assert.Equal(t, "snap-start", finished.snapshotID)

	nilDB := NewGoldenSnapshotService(nil, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	nilDB.Start(context.Background())
	nilDB.Stop()

	emptySnapshotVM := &fakeGoldenVMClient{execAttemptsUntilReady: 1, snapshotID: ""}
	failingBake := NewGoldenSnapshotService(&fakeGoldenDB{}, emptySnapshotVM, func() sandbox.CreateRequest {
		return sandbox.CreateRequest{}
	})
	snapshotID, err := failingBake.bake(context.Background())
	require.Error(t, err)
	assert.Empty(t, snapshotID)
	assert.Contains(t, err.Error(), "empty snapshot id")
	assert.Equal(t, []string{"vm-builder"}, emptySnapshotVM.deletedVMs)
}

func TestGoldenSnapshot_Cov_GCAndReclaimNoOpBranches(t *testing.T) {
	db := &goldenSnapshotCovDB{}
	vm := &fakeGoldenVMClient{}
	svc := NewGoldenSnapshotService(db, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })

	svc.gcSupersededSnapshots(context.Background(), "   ")
	assert.Equal(t, 0, db.supersedeCallCount())

	svc.reclaimStaleBaking(context.Background())
	assert.Equal(t, 1, db.reclaimCallCount())

	svc.MarkBad(context.Background(), "  ")
	assert.Empty(t, db.markedBadIDsSnapshot())
}
