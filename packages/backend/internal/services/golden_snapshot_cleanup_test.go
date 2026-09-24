package services

import (
	"context"
	"errors"
	"os"
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

func TestFailedGoldenBuilderSelectionPostgres(t *testing.T) {
	url := os.Getenv("SMITHERS_SERVICES_TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("SMITHERS_TEST_DATABASE_URL")
	}
	if url == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("services test database URL is required")
		}
		t.Skip("services test database URL is not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	require.NoError(t, err)
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `
 CREATE TEMP TABLE sandbox_golden_snapshots (id text, status text);
 CREATE TEMP TABLE sandbox_instances (id text, resource_id text, resource_kind text, deleted_at timestamptz, created_at timestamptz DEFAULT now());
 INSERT INTO sandbox_golden_snapshots VALUES ('failed-build','failed'), ('ready-build','ready'), ('active-build','baking');
 INSERT INTO sandbox_instances (id,resource_id,resource_kind,deleted_at) VALUES
 ('failed-builder','failed-build','golden_snapshot_bake',NULL),
 ('ready-builder','ready-build','golden_snapshot_bake',NULL),
 ('active-builder','active-build','golden_snapshot_bake',NULL),
 ('user-workspace','failed-build','workspace',NULL),
 ('already-deleted','failed-build','golden_snapshot_bake',now()),
 ('unknown-builder','missing-build','golden_snapshot_bake',NULL);
 `)
	require.NoError(t, err)
	vm := &fakeGoldenVMClient{}
	NewGoldenSnapshotService(conn, vm, nil).cleanupFailedBuilders(ctx)
	require.Equal(t, []string{"failed-builder"}, vm.deletedVMs)
	require.Empty(t, vm.deletedSnapshots)
}
