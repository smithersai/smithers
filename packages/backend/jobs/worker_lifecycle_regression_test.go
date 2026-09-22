package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func waitWorkerSignal[T any](t *testing.T, signal <-chan T, name string) T {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
		var zero T
		return zero
	}
}

func releaseWorkerHandler(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}

func TestWorkerHeartbeatFailureJoinsHandlerBeforeReturn(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "heartbeat-failure", EffectIdempotent, `{"work":true}`)
	input.Operation = "flow.heartbeat-failure"
	_, err := store.Admit(context.Background(), input)
	require.NoError(t, err)

	workerCtx, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	entered := make(chan struct{})
	handlerCancelled := make(chan struct{})
	release := make(chan struct{})
	defer releaseWorkerHandler(release)
	reported := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, WorkerConfig{
			WorkerID: "heartbeat-failure-worker", Capacity: 1, Lease: 300 * time.Millisecond,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: time.Hour,
			Operations: []string{input.Operation},
			OnError: func(workerErr error) {
				select {
				case reported <- workerErr:
				default:
				}
				cancelWorker()
			},
		}, func(handlerCtx context.Context, _ *Lease) error {
			close(entered)
			<-handlerCtx.Done()
			close(handlerCancelled)
			<-release // Simulate a provider cleanup that outlives cancellation.
			return handlerCtx.Err()
		})
	}()
	waitWorkerSignal(t, entered, "handler start")

	// Only the heartbeat touches this name while capacity is occupied. Rename
	// it after the claim commits so the next heartbeat has a real SQL error.
	_, err = store.pool.Exec(context.Background(), `ALTER TABLE product_job_dispatches RENAME TO unavailable_dispatches`)
	require.NoError(t, err)
	waitWorkerSignal(t, handlerCancelled, "heartbeat failure cancellation")
	select {
	case workerErr := <-done:
		t.Fatalf("worker returned before its handler joined: %v", workerErr)
	case <-time.After(150 * time.Millisecond):
	}
	releaseWorkerHandler(release)
	require.NoError(t, waitWorkerSignal(t, done, "worker shutdown"))
	require.Error(t, waitWorkerSignal(t, reported, "heartbeat SQL error"))
}

func TestWorkerCompletionBeforeHandlerReturnIsNotClaimLoss(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "completed-while-handler-open", EffectIdempotent, `{"work":true}`)
	input.Operation = "flow.completed-while-open"
	receipt, err := store.Admit(context.Background(), input)
	require.NoError(t, err)

	workerCtx, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	completed := make(chan error, 1)
	release := make(chan struct{})
	defer releaseWorkerHandler(release)
	reported := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, WorkerConfig{
			WorkerID: "completion-worker", Capacity: 1, Lease: 300 * time.Millisecond,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: time.Hour,
			Operations: []string{input.Operation},
			OnError: func(workerErr error) {
				select {
				case reported <- workerErr:
				default:
				}
			},
		}, func(handlerCtx context.Context, lease *Lease) error {
			completeErr := lease.Complete(handlerCtx, json.RawMessage(`{"done":true}`))
			completed <- completeErr
			<-release // Heartbeat observes a committed terminal operation.
			return completeErr
		})
	}()
	require.NoError(t, waitWorkerSignal(t, completed, "terminal receipt"))
	time.Sleep(350 * time.Millisecond) // More than one heartbeat interval.
	releaseWorkerHandler(release)
	cancelWorker()
	require.NoError(t, waitWorkerSignal(t, done, "worker shutdown"))
	select {
	case workerErr := <-reported:
		t.Fatalf("successful terminal receipt was reported as a worker error: %v", workerErr)
	default:
	}
	operation, err := store.Get(context.Background(), scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCompleted, operation.State)
}

func TestCancellationMakesHourParkImmediatelyClaimable(t *testing.T) {
	for _, cancelBeforePark := range []bool{false, true} {
		name := "after-park"
		if cancelBeforePark {
			name = "before-park"
		}
		t.Run(name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
			input := testAdmission(scope, name, EffectReconcile, `{"work":true}`)
			input.Operation = "flow.cancel-park"
			receipt, err := store.Admit(ctx, input)
			require.NoError(t, err)
			claim, err := store.ClaimForOperations(ctx, "parking-worker", 30*time.Second, []string{input.Operation})
			require.NoError(t, err)
			_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{"provider":"started"}`))
			require.NoError(t, err)
			if cancelBeforePark {
				_, err = store.RequestCancellation(ctx, scope, receipt.OperationID)
				require.NoError(t, err)
			}
			require.NoError(t, store.Park(ctx, claim, json.RawMessage(`{"provider":"running"}`), time.Hour))
			if !cancelBeforePark {
				_, err = store.RequestCancellation(ctx, scope, receipt.OperationID)
				require.NoError(t, err)
			}
			reclaimed, err := store.ClaimForOperations(ctx, "cancel-delivery", 30*time.Second, []string{input.Operation})
			require.NoError(t, err, "cancellation must bypass the hour-long park")
			require.Equal(t, receipt.OperationID, reclaimed.OperationID)
			require.True(t, reclaimed.CancellationRequested)
			require.Equal(t, claim.ExternalAttempt, reclaimed.ExternalAttempt)
			require.NoError(t, store.AcknowledgeCancellation(ctx, reclaimed, json.RawMessage(`{"stopped":true}`)))
			operation, err := store.Get(ctx, scope, receipt.OperationID)
			require.NoError(t, err)
			require.Equal(t, StateCancelled, operation.State)
		})
	}
}

func TestWorkerSettlementTimeoutWhenClaimRowLocked(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "settlement-lock", EffectIdempotent, `{"work":true}`)
	input.Operation = "flow.settlement-lock"
	receipt, err := store.Admit(context.Background(), input)
	require.NoError(t, err)

	workerCtx, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	entered := make(chan struct{})
	release := make(chan struct{})
	defer releaseWorkerHandler(release)
	reported := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, WorkerConfig{
			WorkerID: "settlement-worker", Capacity: 1, Lease: 30 * time.Second,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: time.Hour,
			SettlementTimeout: 150 * time.Millisecond,
			Operations:        []string{input.Operation},
			OnError: func(workerErr error) {
				select {
				case reported <- workerErr:
				default:
				}
				cancelWorker()
			},
		}, func(_ context.Context, _ *Lease) error {
			close(entered)
			<-release
			return errors.New("provider temporarily failed")
		})
	}()
	waitWorkerSignal(t, entered, "handler start")

	lockTx, err := store.pool.Begin(context.Background())
	require.NoError(t, err)
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	var lockedID string
	err = lockTx.QueryRow(context.Background(), `SELECT operation_id FROM product_job_dispatches
		WHERE operation_id=$1 FOR UPDATE`, receipt.OperationID).Scan(&lockedID)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, lockedID)
	releaseWorkerHandler(release)

	select {
	case workerErr := <-done:
		require.NoError(t, workerErr)
	case <-time.After(2 * time.Second):
		t.Fatal("worker settlement remained blocked on a row lock")
	}
	require.Error(t, waitWorkerSignal(t, reported, "bounded settlement error"))
	require.NoError(t, lockTx.Rollback(context.Background()))
}
