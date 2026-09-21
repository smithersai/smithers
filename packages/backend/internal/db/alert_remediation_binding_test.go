package db

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLegacyAlertRemediationLookupUsesPartialExpressionIndex(t *testing.T) {
	ctx := context.Background()
	_, pool := newQueries(t)
	var indexDef string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT indexdef
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND indexname = 'idx_workflow_runs_legacy_alert_incident'
	`).Scan(&indexDef))
	assert.Contains(t, indexDef, "incident_row_id")
	assert.Contains(t, indexDef, "incident_id")
	assert.Contains(t, indexDef, "monitoring_alert")
	assert.Contains(t, indexDef, "remediation_dispatch_token")

	// Force a plan choice independent of the tiny test fixture. The production
	// compatibility statement must be capable of probing the partial index; a
	// regression to JSON-expression sequential scans would omit its name.
	_, err := pool.Exec(ctx, `SET LOCAL enable_seqscan = off`)
	require.NoError(t, err)
	rows, err := pool.Query(ctx, `EXPLAIN (COSTS OFF) `+failCompletedLegacyAlertRemediationIncidents)
	require.NoError(t, err)
	defer rows.Close()
	var planLines []string
	for rows.Next() {
		var line string
		require.NoError(t, rows.Scan(&line))
		planLines = append(planLines, line)
	}
	require.NoError(t, rows.Err())
	assert.Contains(t, strings.Join(planLines, "\n"), "idx_workflow_runs_legacy_alert_incident")
}

func TestHasLegacyAlertRemediationWorkflowRunUsesExactIncidentIdentity(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "legacy-alert-user-"+randSlug(t))
	repositoryID := mustCreateRepo(t, pool, userID, "legacy-alert-repo-"+randSlug(t))
	definition, err := q.CreateWorkflowDefinition(ctx, CreateWorkflowDefinitionParams{
		RepositoryID: repositoryID,
		Name:         "Legacy alert remediation",
		Path:         ".smithers/workflows/legacy-remediate.tsx",
		Config:       []byte(`{}`),
	})
	require.NoError(t, err)

	incidentRowID := int64(412)
	incidentID := "legacy-incident-" + randSlug(t)
	_, err = q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID: repositoryID, WorkflowDefinitionID: definition.ID,
		Status: "running", TriggerEvent: "monitoring_alert", TriggerRef: "main",
		TriggerCommitSha: "legacy-alert-sha", ExecutionPlane: "runner",
		DispatchInputs: []byte(`{"incident_row_id":` + strconv.FormatInt(incidentRowID, 10) + `,"incident_id":"` + incidentID + `"}`),
	})
	require.NoError(t, err)

	exists, err := q.HasLegacyAlertRemediationWorkflowRun(ctx, HasLegacyAlertRemediationWorkflowRunParams{
		IncidentRowID: strconv.FormatInt(incidentRowID, 10),
		IncidentID:    incidentID,
	})
	require.NoError(t, err)
	assert.True(t, exists)

	exists, err = q.HasLegacyAlertRemediationWorkflowRun(ctx, HasLegacyAlertRemediationWorkflowRunParams{
		IncidentRowID: strconv.FormatInt(incidentRowID+1, 10),
		IncidentID:    incidentID,
	})
	require.NoError(t, err)
	assert.False(t, exists)

	exists, err = q.HasLegacyAlertRemediationWorkflowRun(ctx, HasLegacyAlertRemediationWorkflowRunParams{
		IncidentRowID: strconv.FormatInt(incidentRowID, 10),
		IncidentID:    incidentID + "-other",
	})
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestAlertRemediationRunBinding_ExactIdentityAndDispatchUniqueness(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "alert-binding-user-"+randSlug(t))
	repositoryID := mustCreateRepo(t, pool, userID, "alert-binding-repo-"+randSlug(t))
	workflowPath := ".smithers/workflows/remediate.tsx"
	definition, err := q.CreateWorkflowDefinition(ctx, CreateWorkflowDefinitionParams{
		RepositoryID: repositoryID,
		Name:         "Alert remediation",
		Path:         workflowPath,
		Config:       []byte(`{"on":{"webhook":{"types":["monitoring_alert"]}},"jobs":{"fix":{}}}`),
	})
	require.NoError(t, err)

	incidentID := "incident-binding-" + randSlug(t)
	incident, err := q.CreateAlertIncident(ctx, CreateAlertIncidentParams{
		IncidentID: incidentID, PolicyName: "policy-binding", ConditionName: "condition",
		Summary: "summary", IncidentUrl: "https://incident.example/" + incidentID,
		Runbook: "docs/runbooks/test.md", Workflow: workflowPath,
	})
	require.NoError(t, err)
	job, err := q.CreateAlertRemediationJob(ctx, incident.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE alert_remediation_jobs SET status = 'processing' WHERE id = $1`, job.ID)
	require.NoError(t, err)

	dispatchInputs := []byte(`{
		"incident_row_id":` + strconv.FormatInt(incident.ID, 10) + `,
		"incident_id":"` + incidentID + `",
		"remediation_job_id":` + strconv.FormatInt(job.ID, 10) + `,
		"remediation_dispatch_token":"` + job.DispatchToken + `"
	}`)
	run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID: repositoryID, WorkflowDefinitionID: definition.ID,
		Status: "queued", TriggerEvent: "monitoring_alert", TriggerRef: "main",
		TriggerCommitSha: "alert-binding-sha", DispatchInputs: dispatchInputs,
		ExecutionPlane: "runner",
	})
	require.NoError(t, err)
	step, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{
		WorkflowRunID: run.ID, Name: "publish", Position: 1, Status: "running",
	})
	require.NoError(t, err)
	task, err := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
		WorkflowRunID: run.ID, WorkflowStepID: step.ID, RepositoryID: repositoryID,
		Status: "running", Payload: json.RawMessage(`{"job":"publish"}`), AvailableAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	runnerID := mustCreateRunner(t, pool, "alert-binding-runner-"+randSlug(t))
	_, err = pool.Exec(ctx, `
		UPDATE workflow_tasks
		SET runner_id = $1, attempt = 3
		WHERE id = $2
	`, runnerID, task.ID)
	require.NoError(t, err)

	found, err := q.FindAlertRemediationWorkflowRun(ctx, FindAlertRemediationWorkflowRunParams{
		JobID: strconv.FormatInt(job.ID, 10), DispatchToken: []byte(job.DispatchToken),
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, found.ID)

	base := AuthorizeAlertRemediationOutcomeRunParams{
		JobID: job.ID, IncidentRowID: incident.ID, DispatchToken: job.DispatchToken,
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true}, IncidentID: incidentID,
		RepositoryID: repositoryID, WorkflowDefinitionID: definition.ID,
		TaskID: task.ID, RunnerID: pgtype.Int8{Int64: runnerID, Valid: true},
		TaskAttempt: 3, ExpectedJob: "publish",
	}
	for _, tc := range []struct {
		name   string
		mutate func(*AuthorizeAlertRemediationOutcomeRunParams)
	}{
		{name: "wrong job", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.JobID++ }},
		{name: "wrong incident row", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.IncidentRowID++ }},
		{name: "wrong incident id", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.IncidentID += "-forged" }},
		{name: "wrong token", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.DispatchToken = strings.Repeat("f", 64) }},
		{name: "wrong repository", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.RepositoryID++ }},
		{name: "wrong definition", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.WorkflowDefinitionID++ }},
		{name: "wrong run", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.WorkflowRunID.Int64++ }},
		{name: "wrong task", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.TaskID++ }},
		{name: "wrong runner", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.RunnerID.Int64++ }},
		{name: "wrong attempt", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.TaskAttempt++ }},
		{name: "wrong task role", mutate: func(p *AuthorizeAlertRemediationOutcomeRunParams) { p.ExpectedJob = "record-failure" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			params := base
			tc.mutate(&params)
			rows, authErr := q.AuthorizeAlertRemediationOutcomeRun(ctx, params)
			require.NoError(t, authErr)
			assert.Zero(t, rows)
		})
	}

	rows, err := q.AuthorizeAlertRemediationOutcomeRun(ctx, base)
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)
	var boundRunID pgtype.Int8
	err = pool.QueryRow(ctx, `SELECT workflow_run_id FROM alert_remediation_jobs WHERE id = $1`, job.ID).Scan(&boundRunID)
	require.NoError(t, err)
	require.True(t, boundRunID.Valid)
	assert.Equal(t, run.ID, boundRunID.Int64)

	// The database fence is the final idempotency boundary when a stale claimant
	// overlaps the original dispatcher after both preflight lookups saw no run.
	// Keep this last because PostgreSQL intentionally aborts the surrounding
	// test transaction after the expected uniqueness violation.
	_, err = q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID: repositoryID, WorkflowDefinitionID: definition.ID,
		Status: "queued", TriggerEvent: "monitoring_alert", TriggerRef: "main",
		TriggerCommitSha: "alert-binding-duplicate", DispatchInputs: dispatchInputs,
		ExecutionPlane: "runner",
	})
	require.Error(t, err)
}
