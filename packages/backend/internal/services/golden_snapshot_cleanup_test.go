package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

type failingBuilderCleanup struct {
	fakeGoldenVMClient
	fail bool
}

func (f *failingBuilderCleanup) DeleteSandbox(_ context.Context, id string) error {
	f.deletedVMs = append(f.deletedVMs, id)
	if f.fail {
		return errors.New("temporary provider outage")
	}
	return nil
}

func TestFailedGoldenBuildersRetryWithoutRemovingBuildReceipts(t *testing.T) {
	vm := &failingBuilderCleanup{fail: true}
	db := goldenSnapshotHDB{queryFn: func(_ context.Context, query string, _ ...any) (pgx.Rows, error) {
		require.Equal(t, failedGoldenSnapshotBuildersSQL, query)
		return &fakeGoldenRows{rows: []goldenGCRow{{id: "failed-builder", snapshotID: "failed-build"}}}, nil
	}}
	svc := NewGoldenSnapshotService(db, vm, nil)
	svc.cleanupFailedBuilders(context.Background())
	vm.fail = false
	svc.cleanupFailedBuilders(context.Background())
	require.Equal(t, []string{"failed-builder", "failed-builder"}, vm.deletedVMs)
	require.Empty(t, vm.deletedSnapshots)
}

func TestFailedGoldenBuilderCleanupDoesNotDeleteFromPartialRead(t *testing.T) {
	vm := &fakeGoldenVMClient{}
	db := goldenSnapshotHDB{queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
		return &goldenSnapshotHRows{rows: []goldenGCRow{{id: "builder"}}, err: errors.New("incomplete inventory")}, nil
	}}
	NewGoldenSnapshotService(db, vm, nil).cleanupFailedBuilders(context.Background())
	require.Empty(t, vm.deletedVMs)
}
