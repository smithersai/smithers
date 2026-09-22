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
	databaseName := "smithers_issue1661_jobs_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	adminConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "jobs test PostgreSQL admin configuration invalid: %v\n", err)
		os.Exit(1)
	}
	adminConfig.Database = "postgres"
	admin, err := pgx.ConnectConfig(ctx, adminConfig)
	databaseCreated := false
	if err == nil {
		_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize())
		databaseCreated = err == nil
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
	if err != nil {
		fmt.Fprintf(os.Stderr, "jobs test database setup failed: %v\n", err)
		if admin != nil {
			if databaseCreated {
				_, _ = admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
			}
			_ = admin.Close(context.Background())
		}
		os.Exit(1)
	}
	cancel()
	code := main.Run()
	jobsTestDatabase.Close()
	cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
	if _, dropErr := admin.Exec(cleanupContext, "DROP DATABASE "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)"); dropErr != nil {
		fmt.Fprintf(os.Stderr, "jobs test database cleanup failed: %v\n", dropErr)
		if code == 0 {
			code = 1
		}
	}
	cleanupCancel()
	_ = admin.Close(context.Background())
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
	byRequest, err := store.GetByRequest(ctx, owner, "flow.launch", "request-1")
	require.NoError(t, err)
	require.Equal(t, first.OperationID, byRequest.ID)
	_, err = store.GetByRequest(ctx, otherOwner, "flow.launch", "request-1")
	require.NotEqual(t, first.OperationID, other.OperationID)
	require.NoError(t, err)
	_, err = store.GetByRequest(ctx, Scope{TenantID: "tenant-b", PrincipalID: "owner-a"}, "flow.launch", "request-1")
	require.ErrorIs(t, err, ErrNotFound)

	var requestCount, dispatchCount int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestCount))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_dispatches`).Scan(&dispatchCount))
	require.Equal(t, 3, requestCount)
	require.Equal(t, 3, dispatchCount)
}

func TestConcurrentDuplicateAdmissionCreatesOneDispatch(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	const callers = 16
	type result struct {
		receipt RequestReceipt
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, callers)
	var wait sync.WaitGroup
	wait.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer wait.Done()
			<-start
			receipt, err := store.Admit(context.Background(), testAdmission(scope, "same-request", EffectReconcile, `{"flow":"setup"}`))
			results <- result{receipt: receipt, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	operationID := ""
	inserted := 0
	for admitted := range results {
		require.NoError(t, admitted.err)
		if operationID == "" {
			operationID = admitted.receipt.OperationID
		}
		require.Equal(t, operationID, admitted.receipt.OperationID)
		if !admitted.receipt.Joined {
			inserted++
		}
	}
	require.Equal(t, 1, inserted)
	var requests, dispatches, events int
	require.NoError(t, store.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests`).Scan(&requests))
	require.NoError(t, store.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_dispatches`).Scan(&dispatches))
	require.NoError(t, store.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_events`).Scan(&events))
	require.Equal(t, 1, requests)
	require.Equal(t, 1, dispatches)
	require.Equal(t, 1, events)
}

func TestAdmitInTxCommitsWithDomainStateAndRollsBackTogether(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	_, err := store.pool.Exec(ctx, `CREATE TABLE domain_requests (id text PRIMARY KEY)`)
	require.NoError(t, err)

	rolledBack, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = rolledBack.Exec(ctx, `INSERT INTO domain_requests (id) VALUES ('rollback')`)
	require.NoError(t, err)
	_, err = store.AdmitInTx(ctx, rolledBack, testAdmission(scope, "rollback", EffectIdempotent, `{"value":1}`))
	require.NoError(t, err)
	require.NoError(t, rolledBack.Rollback(ctx))

	var domainCount, requestCount int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM domain_requests`).Scan(&domainCount))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestCount))
	require.Zero(t, domainCount)
	require.Zero(t, requestCount)

	committed, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = committed.Exec(ctx, `INSERT INTO domain_requests (id) VALUES ('commit')`)
	require.NoError(t, err)
	receipt, err := store.AdmitInTx(ctx, committed, testAdmission(scope, "commit", EffectIdempotent, `{"value":2}`))
	require.NoError(t, err)
	require.NoError(t, committed.Commit(ctx))
	require.NotEmpty(t, receipt.OperationID)
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM domain_requests`).Scan(&domainCount))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestCount))
	require.Equal(t, 1, domainCount)
	require.Equal(t, 1, requestCount)
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

func TestOperationFilteredParkingReusesExternalAttemptAndDeduplicatesCheckpoint(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	flowAdmission := testAdmission(scope, "flow", EffectReconcile, `{"flow":"setup"}`)
	flowAdmission.Operation = "flow.launch"
	flowReceipt, err := store.Admit(ctx, flowAdmission)
	require.NoError(t, err)
	importAdmission := testAdmission(scope, "import", EffectIdempotent, `{"repository":"private"}`)
	importAdmission.Operation = "repository.import"
	importReceipt, err := store.Admit(ctx, importAdmission)
	require.NoError(t, err)

	first, err := store.ClaimForOperations(ctx, "flow-worker-a", 30*time.Second, []string{"flow.launch"})
	require.NoError(t, err)
	require.Equal(t, flowReceipt.OperationID, first.OperationID)
	stableAttempt, err := store.BeginExternal(ctx, first, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	require.Equal(t, first.Attempt, stableAttempt)
	checkpoint := json.RawMessage(`{"runId":"run-1","cursor":"7","status":"parked"}`)
	require.NoError(t, store.Park(ctx, first, checkpoint, 0))

	operation, err := store.Get(ctx, scope, flowReceipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateWaiting, operation.State)
	require.Equal(t, stableAttempt, operation.ExternalAttempt)
	require.JSONEq(t, string(checkpoint), string(operation.ExternalReceipt))

	second, err := store.ClaimForOperations(ctx, "flow-worker-b", 30*time.Second, []string{"flow.launch", "flow.launch"})
	require.NoError(t, err)
	require.Equal(t, flowReceipt.OperationID, second.OperationID)
	require.Greater(t, second.Attempt, first.Attempt)
	require.Equal(t, stableAttempt, second.ExternalAttempt)
	require.Equal(t, stableAttempt, second.DeliveryAttempt())
	reusedAttempt, err := store.BeginExternal(ctx, second, json.RawMessage(`{"kind":"reconcile"}`))
	require.NoError(t, err)
	require.Equal(t, stableAttempt, reusedAttempt)
	headBefore, err := store.Head(ctx, scope)
	require.NoError(t, err)
	changed, err := store.Checkpoint(ctx, second, checkpoint)
	require.NoError(t, err)
	require.False(t, changed)
	require.NoError(t, store.Park(ctx, second, checkpoint, 0))
	headAfter, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, headBefore, headAfter)

	third, err := store.ClaimForOperations(ctx, "flow-worker-c", 30*time.Second, []string{"flow.launch"})
	require.NoError(t, err)
	require.NoError(t, store.Complete(ctx, third, json.RawMessage(`{"runId":"run-1","status":"completed"}`)))
	importClaim, err := store.ClaimForOperations(ctx, "import-worker", 30*time.Second, []string{"repository.import"})
	require.NoError(t, err)
	require.Equal(t, importReceipt.OperationID, importClaim.OperationID)
	require.NoError(t, store.Complete(ctx, importClaim, json.RawMessage(`{"status":"completed"}`)))
}

func TestRunWorkerRecoversExpiredFilteredClaim(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "crash", EffectIdempotent, `{"work":true}`)
	input.Operation = "flow.recover"
	receipt, err := store.Admit(ctx, input)
	require.NoError(t, err)
	dead, err := store.ClaimForOperations(ctx, "dead-process", 30*time.Second, []string{"flow.recover"})
	require.NoError(t, err)
	_, err = store.pool.Exec(ctx, `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, dead.OperationID)
	require.NoError(t, err)

	workerContext, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	handled := make(chan Claim, 1)
	go func() {
		done <- store.RunWorker(workerContext, WorkerConfig{
			WorkerID: "replacement", Capacity: 1, Lease: time.Second,
			PollInterval: 5 * time.Millisecond, RecoveryInterval: 5 * time.Millisecond,
			Operations: []string{"flow.recover"},
		}, func(handlerContext context.Context, lease *Lease) error {
			if err := lease.Complete(handlerContext, json.RawMessage(`{"status":"completed"}`)); err != nil {
				return err
			}
			handled <- lease.Claim()
			return nil
		})
	}()
	select {
	case replacement := <-handled:
		require.Equal(t, receipt.OperationID, replacement.OperationID)
		require.Greater(t, replacement.Generation, dead.Generation)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not recover and claim expired work")
	}
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not stop")
	}
}

func TestRunWorkerTreatsDurableDeferAsSuccessfulRelease(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "defer", EffectReconcile, `{"work":true}`)
	input.Operation = "flow.defer"
	receipt, err := store.Admit(context.Background(), input)
	require.NoError(t, err)

	workerContext, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	deferred := make(chan error, 1)
	reported := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerContext, WorkerConfig{
			WorkerID: "parking-worker", Capacity: 1, Lease: time.Second,
			PollInterval: 5 * time.Millisecond, Operations: []string{"flow.defer"},
			OnError: func(workerErr error) { reported <- workerErr },
		}, func(handlerContext context.Context, lease *Lease) error {
			if err := lease.StartExternal(handlerContext, json.RawMessage(`{"runtime":"pinned"}`)); err != nil {
				return err
			}
			err := lease.Defer(handlerContext, json.RawMessage(`{"runId":"run-1","cursor":"0"}`), time.Hour)
			deferred <- err
			return err
		})
	}()
	select {
	case err := <-deferred:
		require.ErrorIs(t, err, ErrDeferred)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not durably defer work")
	}
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not stop after defer")
	}
	select {
	case err := <-reported:
		t.Fatalf("durable defer reported a worker error: %v", err)
	default:
	}
	operation, err := store.Get(context.Background(), scope, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateWaiting, operation.State)
}

func TestExternalEffectRecoveryRequiresSafePolicy(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	lostAckReceipt, err := store.Admit(context.Background(), testAdmission(scope, "lost-launch-ack", EffectReconcile, `{"target":"runtime"}`))
	require.NoError(t, err)
	lostAckClaim, err := store.Claim(context.Background(), "launch-worker", 30*time.Second)
	require.NoError(t, err)
	lostAckAttempt, err := store.BeginExternal(context.Background(), lostAckClaim, json.RawMessage(`{"runtimeIdentity":"host-1"}`))
	require.NoError(t, err)
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, lostAckClaim.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpired(context.Background(), 1)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	lostAckClaim, err = store.Claim(context.Background(), "launch-reconciler", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, lostAckReceipt.OperationID, lostAckClaim.OperationID)
	require.True(t, lostAckClaim.NeedsReconciliation)
	require.Equal(t, lostAckAttempt, lostAckClaim.DeliveryAttempt())
	require.JSONEq(t, `{"runtimeIdentity":"host-1"}`, string(lostAckClaim.ExternalReceipt))
	require.NoError(t, store.Complete(context.Background(), lostAckClaim, json.RawMessage(`{"runtimeRunId":"found"}`)))

	unsafeReceipt, err := store.Admit(context.Background(), testAdmission(scope, "unsafe", EffectUnsafe, `{"target":"charge"}`))
	require.NoError(t, err)
	unsafeClaim, err := store.Claim(context.Background(), "worker-a", 30*time.Second)
	require.NoError(t, err)
	require.NoError(t, store.MarkExternalStarted(context.Background(), unsafeClaim, json.RawMessage(`{"phase":"before-call"}`)))
	_, err = store.pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, unsafeClaim.OperationID)
	require.NoError(t, err)
	recovered, err = store.RecoverExpired(context.Background(), 10)
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
	require.Equal(t, unsafeClaim.ExternalAttempt+1, retryClaim.ExternalAttempt)
	require.NoError(t, store.Complete(context.Background(), retryClaim, json.RawMessage(`{"result":"reconciled"}`)))

	reconcileReceipt, err := store.Admit(context.Background(), testAdmission(scope, "reconcile", EffectReconcile, `{"target":"provider"}`))
	require.NoError(t, err)
	reconcileClaim, err := store.Claim(context.Background(), "worker-b", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, reconcileReceipt.OperationID, reconcileClaim.OperationID)
	stableAttempt, err := store.BeginExternal(context.Background(), reconcileClaim, json.RawMessage(`{"externalId":"maybe"}`))
	require.NoError(t, err)
	require.Equal(t, reconcileClaim.Attempt, stableAttempt)
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
	require.Equal(t, stableAttempt, reconcileClaim.ExternalAttempt)
	require.Equal(t, stableAttempt, reconcileClaim.DeliveryAttempt())
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

	deferred, err := store.Admit(context.Background(), testAdmission(scope, "deferred-cancel", EffectReconcile, `{"n":5}`))
	require.NoError(t, err)
	deferredClaim, err := store.Claim(context.Background(), "waiting-worker", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, deferred.OperationID, deferredClaim.OperationID)
	_, err = store.BeginExternal(context.Background(), deferredClaim, json.RawMessage(`{"runtime":"pinned"}`))
	require.NoError(t, err)
	require.NoError(t, store.Park(context.Background(), deferredClaim, json.RawMessage(`{"runId":"running"}`), 0))
	pendingDeferred, err := store.RequestCancellation(context.Background(), scope, deferred.OperationID)
	require.NoError(t, err)
	require.Equal(t, StateWaiting, pendingDeferred.State)
	require.True(t, pendingDeferred.CancellationRequested)
	reconnected, err := store.Claim(context.Background(), "cancel-delivery", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, deferred.OperationID, reconnected.OperationID)
	require.True(t, reconnected.CancellationRequested)
	require.NoError(t, store.AcknowledgeCancellation(context.Background(), reconnected, json.RawMessage(`{"runtimeStatus":"cancelled"}`)))

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
