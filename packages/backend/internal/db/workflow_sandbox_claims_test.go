package db

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func workflowSandboxClaimForRun(t *testing.T, rows []ClaimQueuedWorkflowRunsRow, runID int64) ClaimQueuedWorkflowRunsRow {
	t.Helper()
	for _, row := range rows {
		if row.ID == runID {
			require.True(t, row.ClaimToken.Valid)
			return row
		}
	}
	t.Fatalf("workflow run %d was not claimed", runID)
	return ClaimQueuedWorkflowRunsRow{}
}

func workflowSandboxClaimToken(row ClaimQueuedWorkflowRunsRow) string {
	return uuid.UUID(row.ClaimToken.Bytes).String()
}

func TestWorkflowSandboxClaimLeaseExpiryAndTerminalFencing(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	seq := testSeqCounter.Add(1)
	fix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("sandbox-lease-%d", seq), "sandbox")

	claimed, err := q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	first := workflowSandboxClaimForRun(t, claimed, fix.runID)
	assert.Equal(t, int64(1), first.ClaimGeneration)
	require.True(t, first.ClaimLeaseExpiresAt.Valid)
	assert.True(t, first.ClaimLeaseExpiresAt.Time.After(time.Now()))
	firstToken := workflowSandboxClaimToken(first)

	claimed, err = q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	for _, row := range claimed {
		assert.NotEqual(t, fix.runID, row.ID, "an unexpired lease must not be claimed twice")
	}

	var beforeRenew time.Time
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT lease_expires_at
		FROM workflow_sandbox_claims
		WHERE workflow_run_id = $1
	`, fix.runID).Scan(&beforeRenew))
	time.Sleep(5 * time.Millisecond)
	renewed, err := q.RenewWorkflowSandboxClaim(ctx, RenewWorkflowSandboxClaimParams{
		ID: fix.runID, ClaimToken: firstToken, ClaimGeneration: first.ClaimGeneration,
	})
	require.NoError(t, err)
	require.True(t, renewed.Valid)
	var afterRenew time.Time
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT lease_expires_at
		FROM workflow_sandbox_claims
		WHERE workflow_run_id = $1
	`, fix.runID).Scan(&afterRenew))
	assert.WithinDuration(t, afterRenew, renewed.Time, time.Second)
	assert.True(t, afterRenew.After(beforeRenew), "a healthy worker must extend its lease")

	_, err = sharedPool.Exec(ctx, `
		UPDATE workflow_sandbox_claims
		SET lease_expires_at = NOW() - INTERVAL '1 second'
		WHERE workflow_run_id = $1
	`, fix.runID)
	require.NoError(t, err)

	claimed, err = q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	second := workflowSandboxClaimForRun(t, claimed, fix.runID)
	secondToken := workflowSandboxClaimToken(second)
	assert.NotEqual(t, firstToken, secondToken)
	assert.Greater(t, second.ClaimGeneration, first.ClaimGeneration)

	_, err = q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID: fix.runID, ClaimToken: firstToken, ClaimGeneration: first.ClaimGeneration,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows, "an expired/reclaimed generation cannot terminalize the run")

	// Simulate a previous-version scheduler's status-only finalizer. The
	// rollout guard must suppress it while the new generation is active.
	var staleID int64
	err = sharedPool.QueryRow(ctx, `
		UPDATE workflow_runs
		SET status = 'success', completed_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status IN ('queued', 'running')
		RETURNING id
	`, fix.runID).Scan(&staleID)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	succeeded, err := q.MarkWorkflowRunSuccess(ctx, MarkWorkflowRunSuccessParams{
		ID: fix.runID, ClaimToken: secondToken, ClaimGeneration: second.ClaimGeneration,
	})
	require.NoError(t, err)
	assert.Equal(t, "success", succeeded.Status)

	var storedGeneration int64
	var storedToken *string
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT generation, claim_token::text
		FROM workflow_sandbox_claims
		WHERE workflow_run_id = $1
	`, fix.runID).Scan(&storedGeneration, &storedToken))
	assert.Nil(t, storedToken)
	assert.Greater(t, storedGeneration, second.ClaimGeneration, "terminalization must invalidate the active generation")
}

func TestWorkflowSandboxCancelResumeInvalidatesStaleWorker(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	seq := testSeqCounter.Add(1)
	fix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("sandbox-resume-%d", seq), "sandbox")

	claimed, err := q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	beforeCancel := workflowSandboxClaimForRun(t, claimed, fix.runID)
	beforeToken := workflowSandboxClaimToken(beforeCancel)

	require.NoError(t, q.CancelWorkflowRun(ctx, fix.runID))
	var cancelledGeneration int64
	var cancelledToken *string
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT generation, claim_token::text
		FROM workflow_sandbox_claims
		WHERE workflow_run_id = $1
	`, fix.runID).Scan(&cancelledGeneration, &cancelledToken))
	assert.Nil(t, cancelledToken)
	assert.Greater(t, cancelledGeneration, beforeCancel.ClaimGeneration)

	require.NoError(t, q.ResumeWorkflowRun(ctx, fix.runID))
	_, err = q.MarkWorkflowRunSuccess(ctx, MarkWorkflowRunSuccessParams{
		ID: fix.runID, ClaimToken: beforeToken, ClaimGeneration: beforeCancel.ClaimGeneration,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	// The queued-state guard covers the window between resume and replacement
	// claim for old binaries whose status-only terminal predicate includes
	// queued rows.
	result, err := sharedPool.Exec(ctx, `
		UPDATE workflow_runs
		SET status = 'failure', completed_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status IN ('queued', 'running')
	`, fix.runID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), result.RowsAffected())

	claimed, err = q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	afterResume := workflowSandboxClaimForRun(t, claimed, fix.runID)
	assert.Greater(t, afterResume.ClaimGeneration, cancelledGeneration)

	_, err = q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID: fix.runID, ClaimToken: beforeToken, ClaimGeneration: beforeCancel.ClaimGeneration,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	failed, err := q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID:         fix.runID,
		ClaimToken: workflowSandboxClaimToken(afterResume), ClaimGeneration: afterResume.ClaimGeneration,
	})
	require.NoError(t, err)
	assert.Equal(t, "failure", failed.Status)
}

func TestWorkflowSandboxClaimRecoversLegacyUnleasedRunningRun(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	seq := testSeqCounter.Add(1)
	fix := mustCreateExecutionPlaneFixture(t, fmt.Sprintf("sandbox-legacy-lease-%d", seq), "sandbox")

	_, err := sharedPool.Exec(ctx, `
		UPDATE workflow_runs
		SET status = 'running', updated_at = NOW() - INTERVAL '4 hours'
		WHERE id = $1
	`, fix.runID)
	require.NoError(t, err)

	var claimRows int
	require.NoError(t, sharedPool.QueryRow(ctx, `
		SELECT COUNT(*) FROM workflow_sandbox_claims WHERE workflow_run_id = $1
	`, fix.runID).Scan(&claimRows))
	assert.Zero(t, claimRows)

	claimed, err := q.ClaimQueuedWorkflowRuns(ctx, 100)
	require.NoError(t, err)
	recovered := workflowSandboxClaimForRun(t, claimed, fix.runID)
	assert.Equal(t, int64(1), recovered.ClaimGeneration)
	assert.NotEmpty(t, workflowSandboxClaimToken(recovered))

	// A mismatched generation never renews ownership.
	_, err = q.RenewWorkflowSandboxClaim(ctx, RenewWorkflowSandboxClaimParams{
		ID: fix.runID, ClaimToken: workflowSandboxClaimToken(recovered), ClaimGeneration: recovered.ClaimGeneration + 1,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID: fix.runID, ClaimToken: workflowSandboxClaimToken(recovered), ClaimGeneration: recovered.ClaimGeneration,
	})
	require.NoError(t, err)

	_, err = q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID: fix.runID, ClaimToken: workflowSandboxClaimToken(recovered), ClaimGeneration: recovered.ClaimGeneration,
	})
	assert.True(t, errors.Is(err, pgx.ErrNoRows))
}
