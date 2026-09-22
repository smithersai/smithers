package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

const defaultJobsTestDatabaseURL = "postgres://smithers_test:smithers_architecture_test@127.0.0.1:32768/postgres?sslmode=disable"

var (
	jobsTestDatabase    *pgxpool.Pool
	jobsTestDatabaseURL string
)

func TestMain(main *testing.M) {
	dsn := strings.TrimSpace(os.Getenv("SMITHERS_JOBS_TEST_DATABASE_URL"))
	useProvidedDatabase := dsn != ""
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	}
	if dsn == "" {
		dsn = defaultJobsTestDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	targetConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "jobs test PostgreSQL configuration invalid: %v\n", err)
		os.Exit(1)
	}
	databaseName := targetConfig.ConnConfig.Database
	if !useProvidedDatabase {
		databaseName = "smithers_issue1661_jobs_test"
		adminConfig, parseErr := pgx.ParseConfig(dsn)
		if parseErr != nil {
			err = parseErr
		} else {
			adminConfig.Database = "postgres"
			var admin *pgx.Conn
			admin, err = pgx.ConnectConfig(ctx, adminConfig)
			if err == nil {
				var exists bool
				err = admin.QueryRow(ctx, `SELECT EXISTS (
					SELECT 1 FROM pg_database WHERE datname=$1)`, databaseName).Scan(&exists)
				if err == nil && !exists {
					_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize())
				}
				_ = admin.Close(context.Background())
			}
		}
	}
	if err == nil {
		targetConfig.ConnConfig.Database = databaseName
		parsedURL, parseURLErr := url.Parse(dsn)
		if parseURLErr != nil {
			err = parseURLErr
		} else {
			parsedURL.Path = "/" + databaseName
			jobsTestDatabaseURL = parsedURL.String()
			jobsTestDatabase, err = pgxpool.NewWithConfig(ctx, targetConfig)
		}
	}
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "jobs test database setup failed: %v\n", err)
		os.Exit(1)
	}
	code := main.Run()
	jobsTestDatabase.Close()
	os.Exit(code)
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	schemaName := "case_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err := jobsTestDatabase.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schemaName}.Sanitize())
	require.NoError(t, err)
	targetConfig, err := pgxpool.ParseConfig(jobsTestDatabaseURL)
	require.NoError(t, err)
	targetConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, targetConfig)
	require.NoError(t, err)
	require.NoError(t, pool.Ping(ctx))
	_, err = pool.Exec(ctx, SchemaSQL())
	require.NoError(t, err)
	store, err := NewStore(pool)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		dropContext, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dropCancel()
		_, _ = jobsTestDatabase.Exec(dropContext, "DROP SCHEMA "+pgx.Identifier{schemaName}.Sanitize()+" CASCADE")
	})
	return store
}

func testAdmission(scope Scope, requestID string, policy EffectPolicy, payload string) Admission {
	return Admission{
		Scope: scope, Operation: "flow.launch", RequestID: requestID,
		Payload: json.RawMessage(payload), AuthorizationContext: json.RawMessage(`{"role":"owner"}`),
		EffectPolicy: policy,
	}
}

func TestAdmissionIsIdempotentAndPrivatelyScoped(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	owner := Scope{TenantID: "tenant-a", PrincipalID: "owner-a"}
	first, err := store.Admit(ctx, testAdmission(owner, "request-1", EffectIdempotent, `{"b":2,"a":1}`))
	require.NoError(t, err)
	require.False(t, first.Joined)
	require.Equal(t, "requested", first.Kind)
	require.Equal(t, StateAccepted, first.State)

	joined, err := store.Admit(ctx, testAdmission(owner, "request-1", EffectIdempotent, `{
		"a": 1, "b": 2
	}`))
	require.NoError(t, err)
	require.True(t, joined.Joined)
	require.Equal(t, first.OperationID, joined.OperationID)

	_, err = store.Admit(ctx, testAdmission(owner, "request-1", EffectIdempotent, `{"a":9}`))
	require.ErrorIs(t, err, ErrPayloadConflict)
	differentOperation := testAdmission(owner, "request-1", EffectIdempotent, `{"a":9}`)
	differentOperation.Operation = "repository.import"
	operationScoped, err := store.Admit(ctx, differentOperation)
	require.NoError(t, err)
	require.NotEqual(t, first.OperationID, operationScoped.OperationID)

	otherOwner := Scope{TenantID: "tenant-a", PrincipalID: "owner-b"}
	other, err := store.Admit(ctx, testAdmission(otherOwner, "request-1", EffectIdempotent, `{"a":9}`))
	require.NoError(t, err)
	require.NotEqual(t, first.OperationID, other.OperationID)
	_, err = store.Get(ctx, otherOwner, first.OperationID)
	require.ErrorIs(t, err, ErrNotFound)
	operation, err := store.Get(ctx, owner, first.OperationID)
	require.NoError(t, err)
	require.NotEmpty(t, operation.RequestReceipt)
	require.Empty(t, operation.TerminalReceipt)

	var requestCount, dispatchCount int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestCount))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_dispatches`).Scan(&dispatchCount))
	require.Equal(t, 3, requestCount)
	require.Equal(t, 3, dispatchCount)
}

func TestAdmissionReturnsWhileWorkerLaunchIsUnresolved(t *testing.T) {
	store := newTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	launchEntered := make(chan struct{})
	go func() {
		workerDone <- store.RunWorker(ctx, WorkerConfig{
			WorkerID: "worker-one", Capacity: 1, Lease: 30 * time.Second,
			PollInterval: 5 * time.Millisecond,
		}, func(handlerContext context.Context, lease *Lease) error {
			if err := lease.StartExternal(handlerContext, json.RawMessage(`{"provider":"unresolved"}`)); err != nil {
				return err
			}
			close(launchEntered)
			<-handlerContext.Done()
			return handlerContext.Err()
		})
	}()

	first, err := store.Admit(context.Background(), testAdmission(Scope{TenantID: "single", PrincipalID: "owner"}, "slow-1", EffectIdempotent, `{"work":1}`))
	require.NoError(t, err)
	select {
	case <-launchEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not enter unresolved launch")
	}

	type admissionResult struct {
		receipt RequestReceipt
		err     error
	}
	result := make(chan admissionResult, 1)
	go func() {
		receipt, admitErr := store.Admit(context.Background(), testAdmission(Scope{TenantID: "single", PrincipalID: "owner"}, "slow-2", EffectIdempotent, `{"work":2}`))
		result <- admissionResult{receipt: receipt, err: admitErr}
	}()
	var second RequestReceipt
	select {
	case admitted := <-result:
		require.NoError(t, admitted.err)
		second = admitted.receipt
	case <-time.After(5 * time.Second):
		t.Fatal("admission waited for the unresolved launch")
	}
	require.NotEqual(t, first.OperationID, second.OperationID)

	cancel()
	select {
	case err := <-workerDone:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not stop")
	}
}

func TestCommitRecoveryAndClaimFencing(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	cancelledContext, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := store.Admit(cancelledContext, testAdmission(scope, "pre-commit", EffectIdempotent, `{"x":1}`))
	require.Error(t, err)
	var precommitRows int
	require.NoError(t, store.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE request_id='pre-commit'`).Scan(&precommitRows))
	require.Zero(t, precommitRows)

	receipt, err := store.Admit(context.Background(), testAdmission(scope, "post-commit", EffectIdempotent, `{"x":2}`))
	require.NoError(t, err)
	restarted, err := NewStore(store.pool)
	require.NoError(t, err)
	firstClaim, err := restarted.Claim(context.Background(), "dead-process", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, firstClaim.OperationID)
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, firstClaim.OperationID)
	require.NoError(t, err)
	recovered, err := restarted.RecoverExpired(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	secondClaim, err := restarted.Claim(context.Background(), "replacement", 30*time.Second)
	require.NoError(t, err)
	require.Greater(t, secondClaim.Generation, firstClaim.Generation)
	require.NotEqual(t, secondClaim.Token, firstClaim.Token)

	err = restarted.Complete(context.Background(), firstClaim, json.RawMessage(`{"runId":"stale"}`))
	require.ErrorIs(t, err, ErrClaimLost)
	require.NoError(t, restarted.Complete(context.Background(), secondClaim, json.RawMessage(`{"runId":"actual"}`)))
	operation, err := restarted.Get(context.Background(), scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCompleted, operation.State)
	require.JSONEq(t, `{"runId":"actual"}`, string(operation.TerminalReceipt))
}

func TestExternalEffectRecoveryRequiresSafePolicy(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	unsafeReceipt, err := store.Admit(context.Background(), testAdmission(scope, "unsafe", EffectUnsafe, `{"target":"charge"}`))
	require.NoError(t, err)
	unsafeClaim, err := store.Claim(context.Background(), "worker-a", 30*time.Second)
	require.NoError(t, err)
	require.NoError(t, store.MarkExternalStarted(context.Background(), unsafeClaim, json.RawMessage(`{"phase":"before-call"}`)))
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, unsafeClaim.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpired(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	operation, err := store.Get(context.Background(), scope, unsafeReceipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateUncertain, operation.State)
	_, err = store.Claim(context.Background(), "must-not-repeat", 30*time.Second)
	require.ErrorIs(t, err, ErrNoWork)

	require.NoError(t, store.ResolveUncertain(context.Background(), scope, unsafeReceipt.OperationID, ResolveRetry, json.RawMessage(`{"inspected":true}`)))
	retryClaim, err := store.Claim(context.Background(), "explicit-retry", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, unsafeReceipt.OperationID, retryClaim.OperationID)
	require.NoError(t, store.Complete(context.Background(), retryClaim, json.RawMessage(`{"result":"reconciled"}`)))

	reconcileReceipt, err := store.Admit(context.Background(), testAdmission(scope, "reconcile", EffectReconcile, `{"target":"provider"}`))
	require.NoError(t, err)
	reconcileClaim, err := store.Claim(context.Background(), "worker-b", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, reconcileReceipt.OperationID, reconcileClaim.OperationID)
	require.NoError(t, store.MarkExternalStarted(context.Background(), reconcileClaim, json.RawMessage(`{"externalId":"maybe"}`)))
	require.NoError(t, store.MarkWaiting(context.Background(), reconcileClaim, json.RawMessage(`{"runtimeRunId":"run-1"}`)))
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, reconcileClaim.OperationID)
	require.NoError(t, err)
	recovered, err = store.RecoverExpired(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	reconcileClaim, err = store.Claim(context.Background(), "reconciler", 30*time.Second)
	require.NoError(t, err)
	require.True(t, reconcileClaim.NeedsReconciliation)
	require.JSONEq(t, `{"runtimeRunId":"run-1"}`, string(reconcileClaim.ExternalReceipt))
	require.NoError(t, store.Complete(context.Background(), reconcileClaim, json.RawMessage(`{"externalId":"found"}`)))
}

func TestCancellationReceiptsAndCompletionRace(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	ready, err := store.Admit(context.Background(), testAdmission(scope, "ready", EffectIdempotent, `{"n":1}`))
	require.NoError(t, err)
	cancelled, err := store.RequestCancellation(context.Background(), scope, ready.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCancelled, cancelled.State)
	require.NotEmpty(t, cancelled.TerminalReceipt)

	claimed, err := store.Admit(context.Background(), testAdmission(scope, "claimed", EffectIdempotent, `{"n":2}`))
	require.NoError(t, err)
	claim, err := store.Claim(context.Background(), "worker", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, claimed.OperationID, claim.OperationID)
	pending, err := store.RequestCancellation(context.Background(), scope, claimed.OperationID)
	require.NoError(t, err)
	require.False(t, pending.State.Terminal())
	cancelRequested, err := store.Heartbeat(context.Background(), claim, 30*time.Second)
	require.NoError(t, err)
	require.True(t, cancelRequested)
	require.NoError(t, store.AcknowledgeCancellation(context.Background(), claim, json.RawMessage(`{"killed":true}`)))

	crashed, err := store.Admit(context.Background(), testAdmission(scope, "cancel-then-crash", EffectIdempotent, `{"n":4}`))
	require.NoError(t, err)
	crashedClaim, err := store.Claim(context.Background(), "crashing-worker", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, crashed.OperationID, crashedClaim.OperationID)
	_, err = store.RequestCancellation(context.Background(), scope, crashed.OperationID)
	require.NoError(t, err)
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, crashed.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpired(context.Background(), 1)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	crashedOperation, err := store.Get(context.Background(), scope, crashed.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCancelled, crashedOperation.State)

	racing, err := store.Admit(context.Background(), testAdmission(scope, "race", EffectIdempotent, `{"n":3}`))
	require.NoError(t, err)
	raceClaim, err := store.Claim(context.Background(), "worker", 30*time.Second)
	require.NoError(t, err)
	startRace := make(chan struct{})
	raceErrors := make(chan error, 2)
	var raceWait sync.WaitGroup
	raceWait.Add(2)
	go func() {
		defer raceWait.Done()
		<-startRace
		raceErrors <- store.Complete(context.Background(), raceClaim, json.RawMessage(`{"done":true}`))
	}()
	go func() {
		defer raceWait.Done()
		<-startRace
		_, cancelErr := store.RequestCancellation(context.Background(), scope, racing.OperationID)
		raceErrors <- cancelErr
	}()
	close(startRace)
	raceWait.Wait()
	close(raceErrors)
	for raceErr := range raceErrors {
		require.NoError(t, raceErr)
	}
	afterCancel, err := store.Get(context.Background(), scope, racing.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateCompleted, afterCancel.State)
	require.JSONEq(t, `{"done":true}`, string(afterCancel.TerminalReceipt))
}

func TestOrderedReplayPaginationExpiryRepairAndRevocation(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "private-owner"}
	for index := 0; index < 3; index++ {
		_, err := store.Admit(context.Background(), testAdmission(scope, fmt.Sprintf("event-%d", index), EffectIdempotent, fmt.Sprintf(`{"n":%d}`, index)))
		require.NoError(t, err)
	}
	first, err := store.Replay(context.Background(), scope, 0, 2)
	require.NoError(t, err)
	require.Len(t, first.Events, 2)
	require.True(t, first.More)
	require.Equal(t, int64(1), first.Events[0].Sequence)
	require.Equal(t, int64(2), first.Cursor)
	second, err := store.Replay(context.Background(), scope, first.Cursor, 2)
	require.NoError(t, err)
	require.Len(t, second.Events, 1)
	require.False(t, second.More)
	require.Equal(t, int64(3), second.Cursor)
	_, err = store.Replay(context.Background(), scope, 99, 10)
	require.ErrorIs(t, err, ErrCursorAhead)

	require.NoError(t, store.ExpireEventsThrough(context.Background(), scope, 2))
	_, err = store.Replay(context.Background(), scope, 0, 10)
	var expired *CursorExpiredError
	require.ErrorAs(t, err, &expired)
	require.Equal(t, int64(3), expired.Floor)
	snapshot, err := store.Snapshot(context.Background(), scope, 10)
	require.NoError(t, err)
	require.Equal(t, int64(3), snapshot.Cursor)
	require.Len(t, snapshot.Operations, 3)

	subscription, err := store.Subscribe(context.Background(), scope, snapshot.Cursor, 20*time.Millisecond, nil)
	require.NoError(t, err)
	// Suppress the wake hint to prove periodic authoritative replay repairs a
	// dropped notification rather than relying on in-memory delivery.
	_, err = subscription.connection.Exec(context.Background(), `UNLISTEN smithers_product_jobs`)
	require.NoError(t, err)
	newReceipt, err := store.Admit(context.Background(), testAdmission(scope, "after-drop", EffectIdempotent, `{"n":4}`))
	require.NoError(t, err)
	nextContext, cancel := context.WithTimeout(context.Background(), time.Second)
	event, err := subscription.Next(nextContext)
	cancel()
	require.NoError(t, err)
	require.Equal(t, newReceipt.OperationID, event.OperationID)
	require.Equal(t, int64(4), event.Sequence)
	require.NoError(t, subscription.Close(context.Background()))

	revoked := errors.New("permission revoked")
	revokedSubscription, err := store.Subscribe(context.Background(), scope, event.Sequence, 20*time.Millisecond,
		func(context.Context, Scope) error { return revoked })
	require.NoError(t, err)
	_, err = revokedSubscription.Next(context.Background())
	require.ErrorIs(t, err, revoked)
	require.NoError(t, revokedSubscription.Close(context.Background()))

	otherScope := Scope{TenantID: "tenant", PrincipalID: "someone-else"}
	otherPage, err := store.Replay(context.Background(), otherScope, 0, 10)
	require.NoError(t, err)
	require.Empty(t, otherPage.Events)
}
