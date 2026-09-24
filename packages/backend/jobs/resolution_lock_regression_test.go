package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestUncertainResolutionAndCancellationUseCompatibleLocks(t *testing.T) {
	store := newTestStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	receipt, err := store.Admit(ctx, testAdmission(scope, "uncertain-resolution", EffectUnsafe, `{}`))
	require.NoError(t, err)
	claim, err := store.Claim(ctx, "worker", time.Minute)
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.NoError(t, store.Abandon(ctx, claim, errors.New("lost acknowledgment"), 0))

	// Pause the real resolution after it locks the request, before it updates
	// dispatch. The cancellation then reaches its own conflicting row lock.
	_, err = store.pool.Exec(ctx, `
		CREATE FUNCTION pause_resolution() RETURNS trigger AS $$
		BEGIN
			IF OLD.state='uncertain' AND NEW.state='completed' THEN
				PERFORM pg_advisory_xact_lock(16611234);
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER pause_resolution BEFORE UPDATE ON product_job_requests
		FOR EACH ROW EXECUTE FUNCTION pause_resolution()`)
	require.NoError(t, err)
	barrier, err := store.pool.Acquire(ctx)
	require.NoError(t, err)
	defer barrier.Release()
	_, err = barrier.Exec(ctx, `SELECT pg_advisory_lock(16611234)`)
	require.NoError(t, err)
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_, _ = barrier.Exec(cleanup, `SELECT pg_advisory_unlock(16611234)`)
	}()

	resolutionDone := make(chan error, 1)
	go func() {
		resolutionDone <- store.ResolveUncertain(ctx, scope, receipt.OperationID, ResolveCompleted, json.RawMessage(`{"found":true}`))
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := store.pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=16611234 AND NOT granted
		)`).Scan(&waiting)
		return err == nil && waiting
	}, 2*time.Second, 5*time.Millisecond, "resolution did not reach the barrier")
	cancellationDone := make(chan error, 1)
	go func() {
		_, err := store.RequestCancellation(ctx, scope, receipt.OperationID)
		cancellationDone <- err
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := store.pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
			AND pid<>pg_backend_pid() AND query LIKE '%FOR UPDATE OF%'
			AND cardinality(pg_blocking_pids(pid))>0
		)`).Scan(&waiting)
		return err == nil && waiting
	}, 2*time.Second, 5*time.Millisecond, "cancellation did not reach its row lock")
	_, err = barrier.Exec(ctx, `SELECT pg_advisory_unlock(16611234)`)
	require.NoError(t, err)
	require.NoError(t, waitWorkerSignal(t, resolutionDone, "resolution"))
	require.NoError(t, waitWorkerSignal(t, cancellationDone, "cancellation"))
	operation, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCompleted, operation.State)
}
