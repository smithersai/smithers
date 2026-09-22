package deploymentdb

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAlertIncidentsExt_UpdateStateGuarded_OnlyPromotesOpenToRemediating(t *testing.T) {
	ctx := context.Background()
	q, _ := newQueries(t)

	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-ext-"+randSlug(t), "policy-ext", "condition")

	rows, err := q.UpdateAlertIncidentStateGuarded(ctx, UpdateAlertIncidentStateGuardedParams{ID: incident.ID, State: "remediating"})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows, "open -> remediating must succeed")

	rows, err = q.UpdateAlertIncidentStateGuarded(ctx, UpdateAlertIncidentStateGuardedParams{ID: incident.ID, State: "remediating"})
	require.NoError(t, err)
	assert.Zero(t, rows, "a recovered dispatch acknowledgement is idempotent")

	require.NoError(t, q.UpdateAlertIncidentState(ctx, UpdateAlertIncidentStateParams{ID: incident.ID, State: "pr_opened"}))

	rows, err = q.UpdateAlertIncidentStateGuarded(ctx, UpdateAlertIncidentStateGuardedParams{ID: incident.ID, State: "remediating"})
	require.NoError(t, err)
	assert.Zero(t, rows, "a stale claimant must not downgrade pr_opened")

	got, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "pr_opened", got.State)
}

// TestAlertIncidentsExt_RecordOutcomeGuarded_ResolvedIsFinal covers issue
// #295/#343: once an incident's remediation outcome is recorded as resolved,
// a later duplicate outcome report (e.g. a retried runner callback) must be
// an idempotent no-op rather than overwriting the resolved state.
func TestAlertIncidentsExt_RecordOutcomeGuarded_ResolvedIsFinal(t *testing.T) {
	ctx := context.Background()
	q, _ := newQueries(t)

	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-ext-"+randSlug(t), "policy-ext", "condition")

	rows, err := q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "resolved", RemediationPrUrl: "https://github.example/report/1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	got, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", got.State)
	assert.Equal(t, int32(1), got.Attempts)

	// A late duplicate "failed" report must not overwrite the resolved state.
	rows, err = q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "failed",
	})
	require.NoError(t, err)
	assert.Zero(t, rows, "resolved is final: a late failed report must be an idempotent no-op")

	got, err = q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", got.State)
	assert.Equal(t, int32(1), got.Attempts, "the guarded no-op must not increment attempts")
}

// TestAlertIncidentsExt_RecordOutcomeGuarded_LateSuccessAfterFailedIsAuthoritative
// covers the accepted asymmetry: a late "resolved" report reaching an
// already-failed incident is allowed through, since a late success report is
// authoritative (the remediation did in fact eventually succeed).
func TestAlertIncidentsExt_RecordOutcomeGuarded_LateSuccessAfterFailedIsAuthoritative(t *testing.T) {
	ctx := context.Background()
	q, _ := newQueries(t)

	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-ext-"+randSlug(t), "policy-ext", "condition")

	rows, err := q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "failed",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	rows, err = q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "failed",
	})
	require.NoError(t, err)
	assert.Zero(t, rows, "a duplicate failed callback must be idempotent")
	failed, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, int32(1), failed.Attempts, "a retried failed callback must not double-count the attempt")

	rows, err = q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "resolved", RemediationPrUrl: "https://github.example/report/late",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows, "a late resolved report must win over a prior failed state")

	got, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", got.State)
	assert.True(t, got.ResolvedAt.Valid)
}

func TestAlertIncidentsExt_RecordOutcomeGuarded_LateFailurePreservesDraftPR(t *testing.T) {
	ctx := context.Background()
	q, _ := newQueries(t)
	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-pr-"+randSlug(t), "policy-ext", "condition")

	rows, err := q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "pr_opened", RemediationPrUrl: "https://github.example/pr/1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	rows, err = q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "failed",
	})
	require.NoError(t, err)
	assert.Zero(t, rows)
	got, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "pr_opened", got.State)
	assert.Equal(t, "https://github.example/pr/1", got.RemediationPrUrl)
}

func TestAlertIncidentTerminalStateTrigger_FencesEveryUpdatePath(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	incident := alertIncidentsSQLHCreateIncident(t, q, "incident-trigger-"+randSlug(t), "policy-trigger", "condition")

	firstPR := "https://github.com/smithers-ai/plue/pull/41"
	rows, err := q.RecordAlertIncidentRemediationOutcomeGuarded(ctx, RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID: incident.ID, State: "pr_opened", RemediationPrUrl: firstPR,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	// Bypass every application guard deliberately. The database trigger must
	// preserve the first published PR and its accounting against stale workers
	// and alternative writers, even though PostgreSQL reports the UPDATE itself
	// as having matched a row.
	_, err = pool.Exec(ctx, `
		UPDATE alert_incidents
		SET state = 'pr_opened', remediation_pr_url = $2,
		    attempts = attempts + 100, updated_at = NOW() + INTERVAL '1 day'
		WHERE id = $1
	`, incident.ID, "https://github.com/smithers-ai/plue/pull/999")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE alert_incidents SET state = 'failed', remediation_pr_url = '' WHERE id = $1`, incident.ID)
	require.NoError(t, err)

	pr, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "pr_opened", pr.State)
	assert.Equal(t, firstPR, pr.RemediationPrUrl)
	assert.Equal(t, int32(1), pr.Attempts)

	// Closing the monitoring incident is the one allowed promotion from a draft
	// PR. Once resolved, even same-state updates are immutable no-ops.
	require.NoError(t, q.ResolveAlertIncidentByIncidentID(ctx, incident.IncidentID))
	resolved, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	require.Equal(t, "resolved", resolved.State)
	require.True(t, resolved.ResolvedAt.Valid)

	_, err = pool.Exec(ctx, `
		UPDATE alert_incidents
		SET state = 'resolved', remediation_pr_url = $2,
		    attempts = attempts + 100, resolved_at = NOW() + INTERVAL '1 day'
		WHERE id = $1
	`, incident.ID, "https://github.com/smithers-ai/plue/pull/1000")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE alert_incidents SET state = 'open', resolved_at = NULL WHERE id = $1`, incident.ID)
	require.NoError(t, err)

	after, err := q.GetAlertIncident(ctx, incident.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", after.State)
	assert.Equal(t, firstPR, after.RemediationPrUrl)
	assert.Equal(t, int32(1), after.Attempts)
	assert.Equal(t, resolved.ResolvedAt.Time, after.ResolvedAt.Time)
}

func TestFailExhaustedAlertRemediationJobs_AtomicallyFailsActiveIncident(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	active := alertIncidentsSQLHCreateIncident(t, q, "incident-exhausted-active-"+randSlug(t), "policy-exhausted", "condition")
	activeJob, err := q.CreateAlertRemediationJob(ctx, active.ID)
	require.NoError(t, err)
	resolved := alertIncidentsSQLHCreateIncident(t, q, "incident-exhausted-resolved-"+randSlug(t), "policy-exhausted", "condition")
	resolvedJob, err := q.CreateAlertRemediationJob(ctx, resolved.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpdateAlertIncidentState(ctx, UpdateAlertIncidentStateParams{ID: resolved.ID, State: "resolved"}))

	_, err = pool.Exec(ctx, `
		UPDATE alert_remediation_jobs
		SET status = 'processing', attempts = 3, updated_at = NOW() - INTERVAL '1 hour'
		WHERE id = ANY($1::bigint[])
	`, []int64{activeJob.ID, resolvedJob.ID})
	require.NoError(t, err)

	failedIncidentIDs, err := q.FailExhaustedAlertRemediationJobs(ctx, FailExhaustedAlertRemediationJobsParams{
		VisibilityTimeout: 60,
		MaxAttempts:       3,
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{active.ID}, failedIncidentIDs)

	gotActive, err := q.GetAlertIncident(ctx, active.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", gotActive.State)
	gotResolved, err := q.GetAlertIncident(ctx, resolved.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", gotResolved.State, "exhaustion must never overwrite a resolved outcome")

	for _, jobID := range []int64{activeJob.ID, resolvedJob.ID} {
		var status string
		require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM alert_remediation_jobs WHERE id = $1`, jobID).Scan(&status))
		assert.Equal(t, "failed", status)
	}
}
