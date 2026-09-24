package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type goldenSnapshotHDB struct {
	queryRowFn func(context.Context, string, ...any) pgx.Row
	queryFn    func(context.Context, string, ...any) (pgx.Rows, error)
	execFn     func(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (d goldenSnapshotHDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if d.queryRowFn != nil {
		return d.queryRowFn(ctx, sql, args...)
	}
	return fakeGoldenRow{err: pgx.ErrNoRows}
}

func (d goldenSnapshotHDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if d.queryFn != nil {
		return d.queryFn(ctx, sql, args...)
	}
	return &fakeGoldenRows{}, nil
}

func (d goldenSnapshotHDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if d.execFn != nil {
		return d.execFn(ctx, sql, args...)
	}
	return pgconn.CommandTag{}, nil
}

type goldenSnapshotHRows struct {
	rows    []goldenGCRow
	scanErr error
	err     error
	idx     int
}

func (r *goldenSnapshotHRows) Next() bool {
	if r.idx >= len(r.rows) {
		return false
	}
	r.idx++
	return true
}
func (r *goldenSnapshotHRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	row := r.rows[r.idx-1]
	*(dest[0].(*string)) = row.id
	*(dest[1].(*string)) = row.snapshotID
	return nil
}
func (r *goldenSnapshotHRows) Close()                                       {}
func (r *goldenSnapshotHRows) Err() error                                   { return r.err }
func (r *goldenSnapshotHRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *goldenSnapshotHRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *goldenSnapshotHRows) Values() ([]any, error)                       { return nil, nil }
func (r *goldenSnapshotHRows) RawValues() [][]byte                          { return nil }
func (r *goldenSnapshotHRows) Conn() *pgx.Conn                              { return nil }

type goldenSnapshotHVM struct {
	*fakeGoldenVMClient
	createErr   error
	snapshotErr error
	deleteVMErr error
}

func (v *goldenSnapshotHVM) CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if v.createErr != nil {
		return sandbox.CreateResult{}, v.createErr
	}
	return v.fakeGoldenVMClient.CreateSandbox(context.Background(), sandbox.CreateRequest{})
}

func (v *goldenSnapshotHVM) SnapshotSandbox(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if v.snapshotErr != nil {
		return sandbox.SnapshotResult{}, v.snapshotErr
	}
	return v.fakeGoldenVMClient.SnapshotSandbox(context.Background(), "vm-builder", sandbox.SnapshotRequest{})
}

func (v *goldenSnapshotHVM) DeleteSandbox(context.Context, string) error {
	if v.deleteVMErr != nil {
		return v.deleteVMErr
	}
	return v.fakeGoldenVMClient.DeleteSandbox(context.Background(), "vm-builder")
}

func TestGoldenSnapshot_H_CurrentMarkBadAndRefreshErrors(t *testing.T) {
	assert.Empty(t, (*GoldenSnapshotService)(nil).Current(context.Background()))
	assert.Empty(t, NewGoldenSnapshotService(nil, nil, nil).Current(context.Background()))

	svc := NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return fakeGoldenRow{err: errors.New("lookup failed")}
		},
	}, nil, nil)
	assert.Empty(t, svc.Current(context.Background()))

	svc.cachedID = "cached"
	svc.cachedAt = time.Now()
	assert.Equal(t, "cached", svc.Current(context.Background()))

	var execCalled bool
	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			execCalled = true
			return pgconn.CommandTag{}, errors.New("mark failed")
		},
	}, nil, nil)
	svc.MarkBad(context.Background(), "snap-bad")
	assert.True(t, execCalled)

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			if sql == latestReadyGoldenSnapshotSQL {
				return fakeGoldenRow{err: errors.New("freshness failed")}
			}
			return fakeGoldenRow{err: pgx.ErrNoRows}
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.refresh(context.Background())

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			switch sql {
			case latestReadyGoldenSnapshotSQL, reclaimStaleBakingSQL:
				return fakeGoldenRow{err: pgx.ErrNoRows}
			case insertGoldenSnapshotBakingSQL:
				return fakeGoldenRow{err: errors.New("claim failed")}
			}
			return fakeGoldenRow{err: pgx.ErrNoRows}
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.refresh(context.Background())
}

func TestGoldenSnapshot_H_GCAndReclaimFailureBranches(t *testing.T) {
	svc := NewGoldenSnapshotService(goldenSnapshotHDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, errors.New("supersede failed")
		},
		queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
			return nil, errors.New("query failed")
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.gcSupersededSnapshots(context.Background(), "row-1")

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
			return &goldenSnapshotHRows{rows: []goldenGCRow{{id: "old", snapshotID: "snap"}}, scanErr: errors.New("scan failed")}, nil
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.gcSupersededSnapshots(context.Background(), "row-1")

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
			return &goldenSnapshotHRows{err: errors.New("rows failed")}, nil
		},
	}, &fakeGoldenVMClient{}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.gcSupersededSnapshots(context.Background(), "row-1")

	vm := &fakeGoldenVMClient{deleteSnapshotErr: errors.New("delete failed")}
	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryFn: func(context.Context, string, ...any) (pgx.Rows, error) {
			return &goldenSnapshotHRows{rows: []goldenGCRow{{id: "old", snapshotID: "snap"}}}, nil
		},
	}, vm, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	svc.gcSupersededSnapshots(context.Background(), "row-1")
	assert.Empty(t, vm.deletedSnapshots)

	svc = NewGoldenSnapshotService(goldenSnapshotHDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return fakeGoldenRow{err: errors.New("reclaim failed")}
		},
	}, nil, nil)
	svc.reclaimStaleBaking(context.Background())
}

func TestGoldenSnapshot_H_BakeFailures(t *testing.T) {
	svc := NewGoldenSnapshotService(nil, &goldenSnapshotHVM{
		fakeGoldenVMClient: &fakeGoldenVMClient{},
		createErr:          errors.New("create failed"),
	}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	_, err := svc.bake(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create builder vm")

	svc = NewGoldenSnapshotService(nil, &goldenSnapshotHVM{
		fakeGoldenVMClient: &fakeGoldenVMClient{execAttemptsUntilReady: 1},
		snapshotErr:        errors.New("snapshot failed"),
		deleteVMErr:        errors.New("cleanup failed"),
	}, func() sandbox.CreateRequest { return sandbox.CreateRequest{} })
	_, err = svc.bake(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "snapshot builder vm")
}
