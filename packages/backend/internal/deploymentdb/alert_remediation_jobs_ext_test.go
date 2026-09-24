package deploymentdb

import (
	"context"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

// Real-Postgres tests for the hand-written alert-remediation claim fences.
// The worker tests mock these, so only these tests execute the predicates.

type alertRemediationFixture struct {
	q            *Queries
	pool         DBTX
	repositoryID int64
	definitionID int64
	incident     clusterdb.CreateAlertIncidentRow
	job          clusterdb.AlertRemediationJob
}

func newAlertRemediationFixture(t *testing.T) alertRemediationFixture {
	t.Helper()
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "alert-fence-user-"+randSlug(t))
	repositoryID := mustCreateRepo(t, pool, userID, "alert-fence-repo-"+randSlug(t))
	definition, err := q.CreateWorkflowDefinition(ctx, CreateWorkflowDefinitionParams{
		RepositoryID: repositoryID, Name: "Alert remediation",
		Path: ".smithers/workflows/remediate.tsx", Config: []byte(`{}`),
	})
	require.NoError(t, err)
	incidentID := "incident-fence-" + randSlug(t)
	incident, err := q.CreateAlertIncident(ctx, CreateAlertIncidentParams{
		IncidentID: incidentID, PolicyName: "policy", ConditionName: "condition",
		Summary: "summary", IncidentUrl: "https://incident.example/" + incidentID,
		Runbook: "docs/runbooks/test.md", Workflow: ".smithers/workflows/remediate.tsx",
	})
	require.NoError(t, err)
	job, err := q.CreateAlertRemediationJob(ctx, incident.ID)
	require.NoError(t, err)
	return alertRemediationFixture{q: q, pool: pool, repositoryID: repositoryID, definitionID: definition.ID, incident: incident, job: job}
}

// claim moves the job to processing at the given claim generation.
func (f alertRemediationFixture) claim(t *testing.T, attempts int32) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), `UPDATE alert_remediation_jobs SET status = 'processing', attempts = $2 WHERE id = $1`, f.job.ID, attempts)
	require.NoError(t, err)
}

func (f alertRemediationFixture) run(t *testing.T, status string, inputs string) int64 {
	t.Helper()
	run, err := f.q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID: f.repositoryID, WorkflowDefinitionID: f.definitionID,
		Status: status, TriggerEvent: "monitoring_alert", TriggerRef: "main",
		TriggerCommitSha: "sha-" + randSlug(t)[:8], ExecutionPlane: "runner",
		DispatchInputs: []byte(inputs),
	})
	require.NoError(t, err)
	return run.ID
}

func (f alertRemediationFixture) states(t *testing.T) (jobStatus, incidentState string) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT status FROM alert_remediation_jobs WHERE id = $1`, f.job.ID).Scan(&jobStatus))
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT state FROM alert_incidents WHERE id = $1`, f.incident.ID).Scan(&incidentState))
	return jobStatus, incidentState
}

func (f alertRemediationFixture) tokenInputs() string {
	return `{"incident_row_id":` + strconv.FormatInt(f.incident.ID, 10) +
		`,"incident_id":"` + f.incident.IncidentID +
		`","remediation_job_id":` + strconv.FormatInt(f.job.ID, 10) +
		`,"remediation_dispatch_token":"` + f.job.DispatchToken + `"}`
}

func (f alertRemediationFixture) legacyInputs() string {
	return `{"incident_row_id":` + strconv.FormatInt(f.incident.ID, 10) + `,"incident_id":"` + f.incident.IncidentID + `"}`
}

func TestAlertRemediationFence_RetryAtAttempt(t *testing.T) {
	ctx := context.Background()
	f := newAlertRemediationFixture(t)
	f.claim(t, 2)

	n, err := f.q.RetryAlertRemediationJob(ctx, clusterdb.RetryAlertRemediationJobParams{ID: f.job.ID, ExpectedAttempts: 1, Error: "stale", RetryAfterSeconds: 30})
	require.NoError(t, err)
	assert.Zero(t, n, "an expired claimant cannot requeue a newer attempt")

	n, err = f.q.RetryAlertRemediationJob(ctx, clusterdb.RetryAlertRemediationJobParams{ID: f.job.ID, ExpectedAttempts: 2, Error: "  transient  ", RetryAfterSeconds: 30})
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)
	var status, msg string
	var availableIn float64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT status, error, EXTRACT(EPOCH FROM (available_at - NOW())) FROM alert_remediation_jobs WHERE id = $1`, f.job.ID).Scan(&status, &msg, &availableIn))
	assert.Equal(t, "pending", status)
	assert.Equal(t, "transient", msg)
	assert.InDelta(t, 30, availableIn, 5)

	n, err = f.q.RetryAlertRemediationJob(ctx, clusterdb.RetryAlertRemediationJobParams{ID: f.job.ID, ExpectedAttempts: 2, Error: "again", RetryAfterSeconds: 30})
	require.NoError(t, err)
	assert.Zero(t, n, "a pending job is not a claim to release")
}

func TestAlertRemediationFence_BindRunAtAttempt(t *testing.T) {
	ctx := context.Background()
	f := newAlertRemediationFixture(t)
	f.claim(t, 1)
	runID := f.run(t, "queued", f.tokenInputs())
	otherRunID := f.run(t, "queued", `{"unrelated":true}`)
	bind := func(run int64, mutate func(*clusterdb.BindAlertRemediationJobWorkflowRunAtAttemptParams)) int64 {
		t.Helper()
		p := clusterdb.BindAlertRemediationJobWorkflowRunAtAttemptParams{
			WorkflowRunID: pgtype.Int8{Int64: run, Valid: true}, JobID: f.job.ID,
			IncidentRowID: f.incident.ID, DispatchToken: f.job.DispatchToken, ExpectedAttempts: 1,
		}
		if mutate != nil {
			mutate(&p)
		}
		n, err := f.q.BindAlertRemediationJobWorkflowRunAtAttempt(ctx, p)
		require.NoError(t, err)
		return n
	}

	assert.Zero(t, bind(runID, func(p *clusterdb.BindAlertRemediationJobWorkflowRunAtAttemptParams) { p.ExpectedAttempts = 2 }), "wrong attempt")
	assert.Zero(t, bind(runID, func(p *clusterdb.BindAlertRemediationJobWorkflowRunAtAttemptParams) { p.DispatchToken += "x" }), "wrong token")
	assert.Zero(t, bind(runID, func(p *clusterdb.BindAlertRemediationJobWorkflowRunAtAttemptParams) { p.IncidentRowID++ }), "wrong incident")
	assert.Equal(t, int64(1), bind(runID, nil))
	assert.Equal(t, int64(1), bind(runID, nil), "rebinding the same run is idempotent")
	assert.Zero(t, bind(otherRunID, nil), "a bound job cannot be rebound to a different run")
}

func TestAlertRemediationFence_FailJobAndIncident(t *testing.T) {
	ctx := context.Background()
	f := newAlertRemediationFixture(t)
	f.claim(t, 1)
	fail := func(attempts int32) bool {
		t.Helper()
		failed, err := f.q.FailAlertRemediationJobAndIncident(ctx, clusterdb.FailAlertRemediationJobAndIncidentParams{ID: f.job.ID, ExpectedAttempts: attempts, Error: "  boom  "})
		require.NoError(t, err)
		return failed
	}

	assert.False(t, fail(2), "an expired claimant cannot fail a newer attempt")

	// An active token-bound run for this exact job keeps it alive.
	runID := f.run(t, "running", f.tokenInputs())
	assert.False(t, fail(1), "an active bound run blocks terminal failure")
	jobStatus, incidentState := f.states(t)
	assert.Equal(t, "processing", jobStatus)
	assert.Equal(t, "open", incidentState)

	_, err := f.pool.Exec(ctx, `UPDATE workflow_runs SET status = 'failure' WHERE id = $1`, runID)
	require.NoError(t, err)
	assert.True(t, fail(1))
	jobStatus, incidentState = f.states(t)
	assert.Equal(t, "failed", jobStatus)
	assert.Equal(t, "failed", incidentState)
	assert.False(t, fail(1), "a failed job does not fail again")
}

func TestAlertRemediationFence_FailJobPreservesResolvedIncident(t *testing.T) {
	ctx := context.Background()
	f := newAlertRemediationFixture(t)
	f.claim(t, 1)
	_, err := f.pool.Exec(ctx, `UPDATE alert_incidents SET state = 'resolved' WHERE id = $1`, f.incident.ID)
	require.NoError(t, err)
	failed, err := f.q.FailAlertRemediationJobAndIncident(ctx, clusterdb.FailAlertRemediationJobAndIncidentParams{ID: f.job.ID, ExpectedAttempts: 1, Error: "boom"})
	require.NoError(t, err)
	assert.True(t, failed)
	jobStatus, incidentState := f.states(t)
	assert.Equal(t, "failed", jobStatus)
	assert.Equal(t, "resolved", incidentState)
}

func TestAlertRemediationFence_FailCompletedLegacyIncidents(t *testing.T) {
	ctx := context.Background()
	f := newAlertRemediationFixture(t)
	f.claim(t, 1)

	ids, err := f.q.FailCompletedLegacyAlertRemediationIncidents(ctx)
	require.NoError(t, err)
	assert.NotContains(t, ids, f.incident.ID, "no legacy run means nothing to reconcile")

	runID := f.run(t, "running", f.legacyInputs())
	ids, err = f.q.FailCompletedLegacyAlertRemediationIncidents(ctx)
	require.NoError(t, err)
	assert.NotContains(t, ids, f.incident.ID, "an active legacy run keeps the incident active")

	_, err = f.pool.Exec(ctx, `UPDATE workflow_runs SET status = 'success' WHERE id = $1`, runID)
	require.NoError(t, err)
	ids, err = f.q.FailCompletedLegacyAlertRemediationIncidents(ctx)
	require.NoError(t, err)
	assert.Contains(t, ids, f.incident.ID)
	jobStatus, incidentState := f.states(t)
	assert.Equal(t, "failed", jobStatus)
	assert.Equal(t, "failed", incidentState)

	ids, err = f.q.FailCompletedLegacyAlertRemediationIncidents(ctx)
	require.NoError(t, err)
	assert.NotContains(t, ids, f.incident.ID, "reconciliation is idempotent")
}
