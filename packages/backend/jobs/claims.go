package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type claimRecord struct {
	Status            string
	Policy            EffectPolicy
	ExternalStartedAt *time.Time
	CancelRequested   bool
}

// Claim takes one ready external operation without blocking other workers.
// The monotonic generation and random token together fence every later write.
func (store *Store) Claim(ctx context.Context, workerID string, lease time.Duration) (Claim, error) {
	if workerID == "" {
		return Claim{}, errors.New("jobs: worker ID is required")
	}
	if lease <= 0 {
		return Claim{}, errors.New("jobs: positive lease is required")
	}
	token := uuid.NewString()
	leaseMilliseconds := lease.Milliseconds()
	if leaseMilliseconds < 1 {
		leaseMilliseconds = 1
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Claim{}, err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	var claim Claim
	err = tx.QueryRow(ctx, `
		WITH candidate AS (
			SELECT dispatch.operation_id
			FROM product_job_dispatches dispatch
			JOIN product_job_requests request ON request.id = dispatch.operation_id
			WHERE dispatch.status = 'ready'
			  AND dispatch.next_attempt_at <= clock_timestamp()
			  AND request.state = 'accepted'
			ORDER BY dispatch.next_attempt_at, dispatch.operation_id
			FOR UPDATE OF dispatch SKIP LOCKED
			LIMIT 1
		), claimed AS (
			UPDATE product_job_dispatches dispatch
			SET status='claimed', claim_token=$1, worker_id=$2,
			    claimed_at=clock_timestamp(),
			    lease_expires_at=clock_timestamp() + ($3 * interval '1 millisecond'),
			    generation=dispatch.generation+1, attempt=dispatch.attempt+1,
			    updated_at=clock_timestamp()
			FROM candidate
			WHERE dispatch.operation_id=candidate.operation_id
			RETURNING dispatch.*
		)
		SELECT request.id, request.tenant_id, request.principal_id, request.operation,
		       request.request_id, request.payload, request.authorization_context,
		       claimed.effect_policy, claimed.effect_key, claimed.external_receipt,
		       claimed.attempt,
		       claimed.generation, claimed.claim_token, claimed.worker_id,
		       claimed.lease_expires_at, claimed.reconcile_required,
		       request.cancellation_requested
		FROM claimed JOIN product_job_requests request ON request.id=claimed.operation_id`,
		token, workerID, leaseMilliseconds).Scan(
		&claim.OperationID, &claim.Scope.TenantID, &claim.Scope.PrincipalID,
		&claim.Operation, &claim.RequestID, &claim.Payload, &claim.AuthorizationContext,
		&claim.EffectPolicy, &claim.EffectKey, &claim.ExternalReceipt,
		&claim.Attempt, &claim.Generation,
		&claim.Token, &claim.WorkerID, &claim.LeaseExpiresAt, &claim.NeedsReconciliation,
		&claim.CancellationRequested,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Claim{}, ErrNoWork
	}
	if err != nil {
		return Claim{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_requests SET state='dispatching', updated_at=clock_timestamp()
		WHERE id=$1`, claim.OperationID); err != nil {
		return Claim{}, err
	}
	data, _ := json.Marshal(map[string]any{
		"attempt": claim.Attempt, "generation": claim.Generation,
		"reconcile": claim.NeedsReconciliation,
	})
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.claimed", StateDispatching, data); err != nil {
		return Claim{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Claim{}, err
	}
	return claim, nil
}

func lockClaim(ctx context.Context, tx pgx.Tx, claim Claim) (claimRecord, error) {
	var record claimRecord
	err := tx.QueryRow(ctx, `
		SELECT dispatch.status, dispatch.effect_policy, dispatch.external_started_at,
		       request.cancellation_requested
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE dispatch.operation_id=$1 AND dispatch.claim_token=$2
		  AND dispatch.generation=$3 AND dispatch.worker_id=$4
		  AND dispatch.status='claimed'
		  AND dispatch.lease_expires_at > clock_timestamp()
		FOR UPDATE OF dispatch, request`, claim.OperationID, claim.Token, claim.Generation, claim.WorkerID).Scan(
		&record.Status, &record.Policy, &record.ExternalStartedAt, &record.CancelRequested,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimRecord{}, ErrClaimLost
	}
	return record, err
}

// Heartbeat renews a live claim and returns durable cancellation intent.
func (store *Store) Heartbeat(ctx context.Context, claim Claim, lease time.Duration) (bool, error) {
	if lease <= 0 {
		return false, errors.New("jobs: positive lease is required")
	}
	leaseMilliseconds := lease.Milliseconds()
	if leaseMilliseconds < 1 {
		leaseMilliseconds = 1
	}
	var cancelRequested bool
	err := store.pool.QueryRow(ctx, `
		UPDATE product_job_dispatches dispatch
		SET lease_expires_at=clock_timestamp() + ($5 * interval '1 millisecond'),
		    updated_at=clock_timestamp()
		FROM product_job_requests request
		WHERE dispatch.operation_id=$1 AND dispatch.claim_token=$2
		  AND dispatch.generation=$3 AND dispatch.worker_id=$4
		  AND dispatch.status='claimed'
		  AND dispatch.lease_expires_at > clock_timestamp()
		  AND request.id=dispatch.operation_id
		RETURNING request.cancellation_requested`, claim.OperationID, claim.Token,
		claim.Generation, claim.WorkerID, leaseMilliseconds).Scan(&cancelRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrClaimLost
	}
	return cancelRequested, err
}

// MarkExternalStarted must be committed immediately before invoking the
// provider. Recovery uses this marker to avoid repeating ambiguous effects.
func (store *Store) MarkExternalStarted(ctx context.Context, claim Claim, observation json.RawMessage) error {
	canonical, err := canonicalJSON(observation, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	if record.ExternalStartedAt != nil {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_dispatches
		SET external_started_at=clock_timestamp(),
		    reconcile_required=false, updated_at=clock_timestamp()
		WHERE operation_id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_requests SET state='running', updated_at=clock_timestamp()
		WHERE id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.started", StateRunning, canonical); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkWaiting persists the external system's acceptance receipt separately
// from both the original request receipt and the eventual terminal receipt.
func (store *Store) MarkWaiting(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	if _, err := lockClaim(ctx, tx, claim); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET external_receipt=$2, updated_at=clock_timestamp() WHERE operation_id=$1`,
		claim.OperationID, canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state='waiting', updated_at=clock_timestamp() WHERE id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.waiting", StateWaiting, canonical); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (store *Store) Complete(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateCompleted, "operation.completed", receipt, false)
}

func (store *Store) Fail(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateFailed, "operation.failed", receipt, false)
}

func (store *Store) AcknowledgeCancellation(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateCancelled, "operation.cancelled", receipt, true)
}

func (store *Store) settleClaim(ctx context.Context, claim Claim, state State, eventType string, receipt json.RawMessage, requireCancellation bool) error {
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	if requireCancellation && !record.CancelRequested {
		return ErrCancellationNotRequested
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_requests
		SET state=$2, terminal_receipt=$3, updated_at=clock_timestamp()
		WHERE id=$1`, claim.OperationID, state, canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_dispatches
		SET status='done', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
		    lease_expires_at=NULL, updated_at=clock_timestamp()
		WHERE operation_id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, eventType, state, canonical); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Abandon applies the persisted external-effect policy. It never blindly
// retries an unsafe effect once its pre-call marker was committed.
func (store *Store) Abandon(ctx context.Context, claim Claim, cause error, delay time.Duration) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	message := "worker abandoned claim"
	if cause != nil {
		message = cause.Error()
	}
	if err := recoverClaim(ctx, tx, claim.Scope, claim.OperationID, record.Policy, record.ExternalStartedAt != nil, record.CancelRequested, message, delay); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func recoverClaim(ctx context.Context, tx pgx.Tx, scope Scope, operationID string, policy EffectPolicy, externalStarted, cancelRequested bool, message string, delay time.Duration) error {
	if externalStarted && policy == EffectUnsafe {
		receipt, _ := json.Marshal(map[string]any{"kind": "uncertain", "reason": message})
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='uncertain', terminal_receipt=$2, updated_at=clock_timestamp()
			WHERE id=$1`, operationID, receipt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='stopped', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
			    lease_expires_at=NULL, last_error=$2, updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID, message); err != nil {
			return err
		}
		_, err := appendEvent(ctx, tx, scope, operationID, "operation.uncertain", StateUncertain, receipt)
		return err
	}
	if cancelRequested && !externalStarted {
		receipt := json.RawMessage(`{"kind":"cancelled-before-external-effect"}`)
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='cancelled', terminal_receipt=$2, updated_at=clock_timestamp()
			WHERE id=$1`, operationID, receipt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='done', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
			    lease_expires_at=NULL, last_error=$2, updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID, message); err != nil {
			return err
		}
		_, err := appendEvent(ctx, tx, scope, operationID, "operation.cancelled", StateCancelled, receipt)
		return err
	}
	reconcile := externalStarted && (policy == EffectReconcile || cancelRequested)
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state='accepted', updated_at=clock_timestamp() WHERE id=$1`, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET status='ready', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
		    lease_expires_at=NULL, reconcile_required=$2,
		    next_attempt_at=clock_timestamp() + ($3 * interval '1 millisecond'),
		    last_error=$4, updated_at=clock_timestamp()
		WHERE operation_id=$1`, operationID, reconcile, maxMilliseconds(delay), message); err != nil {
		return err
	}
	eventType := "operation.retry_scheduled"
	if reconcile {
		eventType = "operation.reconciliation_required"
	}
	data, _ := json.Marshal(map[string]any{"reason": message, "reconcile": reconcile})
	_, err := appendEvent(ctx, tx, scope, operationID, eventType, StateAccepted, data)
	return err
}

func maxMilliseconds(delay time.Duration) int64 {
	if delay <= 0 {
		return 0
	}
	if delay.Milliseconds() < 1 {
		return 1
	}
	return delay.Milliseconds()
}

// RecoverExpired reclaims up to limit expired leases. Multiple processes can
// run it concurrently; SKIP LOCKED partitions recovery work.
func (store *Store) RecoverExpired(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	recovered := 0
	for recovered < limit {
		didRecover, err := store.recoverOne(ctx)
		if err != nil {
			return recovered, err
		}
		if !didRecover {
			break
		}
		recovered++
	}
	return recovered, nil
}

func (store *Store) recoverOne(ctx context.Context) (bool, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	var scope Scope
	var operationID string
	var policy EffectPolicy
	var externalStarted, cancelRequested bool
	err = tx.QueryRow(ctx, `
		SELECT request.tenant_id, request.principal_id, dispatch.operation_id,
		       dispatch.effect_policy, dispatch.external_started_at IS NOT NULL,
		       request.cancellation_requested
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE dispatch.status='claimed' AND dispatch.lease_expires_at <= clock_timestamp()
		ORDER BY dispatch.lease_expires_at, dispatch.operation_id
		FOR UPDATE OF dispatch, request SKIP LOCKED
		LIMIT 1`).Scan(&scope.TenantID, &scope.PrincipalID, &operationID, &policy, &externalStarted, &cancelRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := recoverClaim(ctx, tx, scope, operationID, policy, externalStarted, cancelRequested, "claim lease expired", 0); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

type UncertainResolution string

const (
	ResolveRetry     UncertainResolution = "retry"
	ResolveCompleted UncertainResolution = "completed"
	ResolveFailed    UncertainResolution = "failed"
	ResolveCancelled UncertainResolution = "cancelled"
)

// ResolveUncertain is the explicit operator/reconciler decision required for
// an ambiguous unsafe effect.
func (store *Store) ResolveUncertain(ctx context.Context, scope Scope, operationID string, resolution UncertainResolution, receipt json.RawMessage) error {
	if err := scope.validate(); err != nil {
		return err
	}
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	operation, err := queryOperation(ctx, tx, scope, operationID, true)
	if err != nil {
		return err
	}
	if operation.State != StateUncertain {
		return ErrUncertainResolution
	}
	if resolution == ResolveRetry {
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='accepted', terminal_receipt=NULL, updated_at=clock_timestamp()
			WHERE id=$1`, operationID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='ready', external_started_at=NULL, external_receipt=NULL,
			    reconcile_required=false, next_attempt_at=clock_timestamp(),
			    last_error='', updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID); err != nil {
			return err
		}
		if _, err := appendEvent(ctx, tx, scope, operationID, "operation.retry_authorized", StateAccepted, canonical); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	var state State
	var eventType string
	switch resolution {
	case ResolveCompleted:
		state, eventType = StateCompleted, "operation.completed"
	case ResolveFailed:
		state, eventType = StateFailed, "operation.failed"
	case ResolveCancelled:
		state, eventType = StateCancelled, "operation.cancelled"
	default:
		return fmt.Errorf("jobs: invalid uncertain resolution %q", resolution)
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state=$2, terminal_receipt=$3, updated_at=clock_timestamp() WHERE id=$1`,
		operationID, state, canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET status='done', updated_at=clock_timestamp() WHERE operation_id=$1`, operationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, scope, operationID, eventType, state, canonical); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
