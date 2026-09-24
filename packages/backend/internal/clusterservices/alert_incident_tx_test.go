package clusterservices

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
)

// alertIncidentTxFakeRow is a minimal pgx.Row fake that scans a fixed set of
// positional values into the destination pointers the generated
// alert_incidents queries pass to Scan.
type alertIncidentTxFakeRow struct {
	values []any
	err    error
}

func (r alertIncidentTxFakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		switch v := d.(type) {
		case *int64:
			*v = r.values[i].(int64)
		case *int32:
			*v = r.values[i].(int32)
		case *string:
			*v = r.values[i].(string)
		case *pgtype.Timestamptz:
			*v = r.values[i].(pgtype.Timestamptz)
		case *pgtype.Text:
			*v = r.values[i].(pgtype.Text)
		case *pgtype.Int8:
			*v = r.values[i].(pgtype.Int8)
		case *time.Time:
			*v = r.values[i].(time.Time)
		default:
			panic("alertIncidentTxFakeRow: unsupported scan destination type")
		}
	}
	return nil
}

// alertIncidentTxFakeTx is a pgx.Tx fake that records advisory-lock Exec
// calls, routes QueryRow calls to a caller-supplied handler (so each
// generated query in the admission critical section can be driven
// independently), and tracks Commit/Rollback so tests can assert
// transaction discipline (issue #328).
type alertIncidentTxFakeTx struct {
	pgx.Tx
	execCalls      []string
	execErr        error
	dedupeHits     int64
	dedupeErr      error
	queryRowFn     func(ctx context.Context, sql string, args ...any) pgx.Row
	commitCalled   bool
	commitErr      error
	rollbackCalled bool
}

func (tx *alertIncidentTxFakeTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, sql)
	if tx.execErr != nil {
		return pgconn.CommandTag{}, tx.execErr
	}
	if strings.Contains(sql, "IncrementActiveAlertIncident") {
		return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", tx.dedupeHits)), tx.dedupeErr
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *alertIncidentTxFakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.queryRowFn(ctx, sql, args...)
}

func (tx *alertIncidentTxFakeTx) Commit(context.Context) error {
	tx.commitCalled = true
	return tx.commitErr
}

func (tx *alertIncidentTxFakeTx) Rollback(context.Context) error {
	tx.rollbackCalled = true
	return nil
}

// alertIncidentTxFakeQuerier implements alertIncidentTxQuerier (BeginTx/WithTx
// plus the plain AlertIncidentQuerier methods via the embedded fake) so
// HandleAlertIncident's advisory-lock path can be exercised without a real
// Postgres connection: WithTx hands the fake tx straight to db.New, exactly
// what *deploymentdb.Queries.WithTx does in production since pgx.Tx satisfies db.DBTX.
type alertIncidentTxFakeQuerier struct {
	*fakeAlertIncidentQuerier
	beginErr error
	tx       *alertIncidentTxFakeTx
}

func (q *alertIncidentTxFakeQuerier) BeginTx(context.Context) (pgx.Tx, error) {
	if q.beginErr != nil {
		return nil, q.beginErr
	}
	return q.tx, nil
}

func (q *alertIncidentTxFakeQuerier) WithTx(tx pgx.Tx) *deploymentdb.Queries {
	return deploymentdb.New(tx)
}

var _ alertIncidentTxQuerier = (*alertIncidentTxFakeQuerier)(nil)

func alertIncidentTxCreateRow(id int64, policyName string) pgx.Row {
	now := time.Now().UTC()
	return alertIncidentTxFakeRow{values: []any{
		id, "0.lock", policyName, "cond", "open", "summary", "url", "runbook", "workflow",
		"", int32(0), now, pgtype.Timestamptz{}, now,
		"monitoring", int32(1), now, pgtype.Timestamptz{}, pgtype.Text{}, pgtype.Timestamptz{}, pgtype.Text{}, pgtype.Text{},
	}}
}

func alertIncidentTxCountRow(count int64) pgx.Row {
	return alertIncidentTxFakeRow{values: []any{count}}
}

func alertIncidentTxJobRow(jobID, incidentID int64) pgx.Row {
	now := time.Now().UTC()
	return alertIncidentTxFakeRow{values: []any{
		jobID, incidentID, "pending", int32(0), "", now, pgtype.Timestamptz{}, now, now,
		strings.Repeat("a", 64), pgtype.Int8{},
	}}
}

// TestHandleAlertIncident_AdmissionRunsInAdvisoryLockedTx covers issue #328:
// when a transactional querier is configured, admission must take the
// per-policy advisory lock before the insert, count, and enqueue, and commit
// only after the enqueue succeeds.
func TestHandleAlertIncident_AdmissionRunsInAdvisoryLockedTx(t *testing.T) {
	t.Parallel()

	var queryOrder []string
	fakeTx := &alertIncidentTxFakeTx{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			switch {
			case strings.Contains(sql, "-- name: CreateAlertIncident"):
				queryOrder = append(queryOrder, "create")
				return alertIncidentTxCreateRow(42, "Smithers High Error Rate - prod")
			case strings.Contains(sql, "-- name: CountActiveAlertIncidentsForPolicy"):
				queryOrder = append(queryOrder, "count_active")
				return alertIncidentTxCountRow(0)
			case strings.Contains(sql, "-- name: CountAlertRemediationJobsForPolicySince"):
				queryOrder = append(queryOrder, "count_attempts")
				return alertIncidentTxCountRow(0)
			case strings.Contains(sql, "-- name: CreateAlertRemediationJob"):
				queryOrder = append(queryOrder, "enqueue")
				return alertIncidentTxJobRow(7, 42)
			default:
				t.Fatalf("unexpected query: %s", sql)
				return nil
			}
		},
	}
	txQuerier := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, tx: fakeTx}
	svc := NewAlertIncidentService(txQuerier, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.lock", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)

	require.Len(t, fakeTx.execCalls, 2)
	assert.Contains(t, fakeTx.execCalls[1], "IncrementActiveAlertIncident")
	assert.Contains(t, fakeTx.execCalls[0], "pg_advisory_xact_lock")
	assert.Contains(t, fakeTx.execCalls[0], "alert_admission:")
	assert.Equal(t, []string{"create", "count_active", "count_attempts", "enqueue"}, queryOrder,
		"the lock must be held across the insert, both counts, and the enqueue")
	assert.True(t, fakeTx.commitCalled)
}

// TestHandleAlertIncident_AdmissionErrorRollsBackTx covers the failure path:
// an error partway through the critical section (here, the active-incident
// count) must prevent the enqueue and the commit.
func TestHandleAlertIncident_AdmissionErrorRollsBackTx(t *testing.T) {
	t.Parallel()

	enqueueCalled := false
	fakeTx := &alertIncidentTxFakeTx{
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			switch {
			case strings.Contains(sql, "-- name: CreateAlertIncident"):
				return alertIncidentTxCreateRow(42, "Smithers High Error Rate - prod")
			case strings.Contains(sql, "-- name: CountActiveAlertIncidentsForPolicy"):
				return alertIncidentTxFakeRow{err: errors.New("count failed")}
			case strings.Contains(sql, "-- name: CreateAlertRemediationJob"):
				enqueueCalled = true
				return alertIncidentTxJobRow(7, 42)
			default:
				t.Fatalf("unexpected query: %s", sql)
				return nil
			}
		},
	}
	txQuerier := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, tx: fakeTx}
	svc := NewAlertIncidentService(txQuerier, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.lockerr", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.Error(t, err)
	assert.False(t, enqueueCalled)
	assert.False(t, fakeTx.commitCalled)
	assert.True(t, fakeTx.rollbackCalled)
}

// TestHandleAlertIncident_AdmissionLockErrorAbortsBeforeInsert covers the
// advisory-lock Exec itself failing: the insert must never run.
func TestHandleAlertIncident_AdmissionLockErrorAbortsBeforeInsert(t *testing.T) {
	t.Parallel()

	fakeTx := &alertIncidentTxFakeTx{
		execErr: errors.New("lock failed"),
		queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
			t.Fatalf("unexpected query after lock failure: %s", sql)
			return nil
		},
	}
	txQuerier := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, tx: fakeTx}
	svc := NewAlertIncidentService(txQuerier, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.lockexecerr", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.Error(t, err)
	assert.False(t, fakeTx.commitCalled)
	assert.True(t, fakeTx.rollbackCalled)
}

// TestHandleAlertIncident_BeginTxErrorPropagates covers BeginTx itself
// failing (e.g. pool exhaustion).
func TestHandleAlertIncident_BeginTxErrorPropagates(t *testing.T) {
	t.Parallel()

	txQuerier := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, beginErr: errors.New("connection pool exhausted")}
	svc := NewAlertIncidentService(txQuerier, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.beginerr", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.Error(t, err)
}

func TestHandleAlertIncident_DedupeUnderAdvisoryLock(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			tx := &alertIncidentTxFakeTx{dedupeHits: 1, queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
				t.Fatalf("dedupe must not insert or enqueue: %s", sql)
				return nil
			}}
			if fail {
				tx.dedupeErr = errors.New("dedupe failed")
			}
			q := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, tx: tx}
			err := NewAlertIncidentService(q, testAlertRegistry(t)).HandleAlertIncident(context.Background(), MonitoringAlertIncident{IncidentID: "repeat", PolicyName: "Smithers High Error Rate - prod", ConditionName: "condition", State: "open"})
			if fail {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Len(t, tx.execCalls, 2)
			require.Contains(t, tx.execCalls[0], "pg_advisory_xact_lock")
			require.Contains(t, tx.execCalls[1], "IncrementActiveAlertIncident")
			require.Equal(t, !fail, tx.commitCalled)
			require.True(t, tx.rollbackCalled)
		})
	}
}

func TestHandleAlertIncident_CloseUnderAdvisoryLock(t *testing.T) {
	tx := &alertIncidentTxFakeTx{queryRowFn: func(_ context.Context, sql string, _ ...any) pgx.Row {
		t.Fatalf("close must not enqueue: %s", sql)
		return nil
	}}
	q := &alertIncidentTxFakeQuerier{fakeAlertIncidentQuerier: &fakeAlertIncidentQuerier{}, tx: tx}
	err := NewAlertIncidentService(q, testAlertRegistry(t)).HandleAlertIncident(context.Background(), MonitoringAlertIncident{IncidentID: "deduplicated", PolicyName: "Smithers High Error Rate - prod", State: "closed"})
	require.NoError(t, err)
	require.Len(t, tx.execCalls, 2)
	require.Contains(t, tx.execCalls[0], "pg_advisory_xact_lock")
	require.Contains(t, tx.execCalls[1], "ResolveAlertIncidentByIncidentID")
	require.True(t, tx.commitCalled)
}
