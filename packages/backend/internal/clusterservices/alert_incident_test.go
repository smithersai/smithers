package clusterservices

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
)

type fakeAlertIncidentQuerier struct {
	dedupeErr              error
	dedupeHits             int64
	dedupeArgs             []clusterdb.IncrementActiveAlertIncidentParams
	createErr              error
	activeForPolicy        int64
	attemptsSince          int64
	resolved               []string
	createdIncidents       []clusterdb.CreateAlertIncidentParams
	enqueuedJobs           []int64
	outcomes               []clusterdb.RecordAlertIncidentRemediationOutcomeGuardedParams
	incidentByID           map[string]clusterdb.AlertIncident
	outcomeAlreadyResolved bool // when true, RecordAlertIncidentRemediationOutcomeGuarded reports 0 rows affected (idempotent no-op)
	authorizedOutcomeRows  int64
	authorizedOutcomeErr   error
	authorizedOutcome      []clusterdb.AuthorizeAlertRemediationOutcomeRunParams
}

func (f *fakeAlertIncidentQuerier) CreateAlertIncident(_ context.Context, arg clusterdb.CreateAlertIncidentParams) (clusterdb.CreateAlertIncidentRow, error) {
	if f.createErr != nil {
		return clusterdb.CreateAlertIncidentRow{}, f.createErr
	}
	f.createdIncidents = append(f.createdIncidents, arg)
	return clusterdb.CreateAlertIncidentRow{ID: int64(len(f.createdIncidents)), IncidentID: arg.IncidentID, PolicyName: arg.PolicyName}, nil
}

func (f *fakeAlertIncidentQuerier) ResolveAlertIncidentByIncidentID(_ context.Context, incidentID string) error {
	f.resolved = append(f.resolved, incidentID)
	return nil
}

func (f *fakeAlertIncidentQuerier) CountActiveAlertIncidentsForPolicy(_ context.Context, _ clusterdb.CountActiveAlertIncidentsForPolicyParams) (int64, error) {
	return f.activeForPolicy, nil
}

func (f *fakeAlertIncidentQuerier) CountAlertRemediationJobsForPolicySince(_ context.Context, _ clusterdb.CountAlertRemediationJobsForPolicySinceParams) (int64, error) {
	return f.attemptsSince, nil
}

func (f *fakeAlertIncidentQuerier) CreateAlertRemediationJob(_ context.Context, incidentID int64) (clusterdb.AlertRemediationJob, error) {
	f.enqueuedJobs = append(f.enqueuedJobs, incidentID)
	return clusterdb.AlertRemediationJob{ID: int64(len(f.enqueuedJobs)), IncidentID: incidentID}, nil
}

func (f *fakeAlertIncidentQuerier) GetAlertIncidentByIncidentID(_ context.Context, incidentID string) (clusterdb.AlertIncident, error) {
	row, ok := f.incidentByID[incidentID]
	if !ok {
		return clusterdb.AlertIncident{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeAlertIncidentQuerier) GetAlertIncident(_ context.Context, id int64) (clusterdb.AlertIncident, error) {
	for _, row := range f.incidentByID {
		if row.ID == id {
			return row, nil
		}
	}
	return clusterdb.AlertIncident{}, pgx.ErrNoRows
}

func (f *fakeAlertIncidentQuerier) AuthorizeAlertRemediationOutcomeRun(_ context.Context, arg clusterdb.AuthorizeAlertRemediationOutcomeRunParams) (int64, error) {
	f.authorizedOutcome = append(f.authorizedOutcome, arg)
	return f.authorizedOutcomeRows, f.authorizedOutcomeErr
}

func (f *fakeAlertIncidentQuerier) RecordAlertIncidentRemediationOutcomeGuarded(_ context.Context, arg clusterdb.RecordAlertIncidentRemediationOutcomeGuardedParams) (int64, error) {
	if f.outcomeAlreadyResolved {
		return 0, nil
	}
	f.outcomes = append(f.outcomes, arg)
	return 1, nil
}

func testAlertRegistry(t *testing.T) *alertregistry.Registry {
	t.Helper()
	registry, err := alertregistry.Parse([]byte(`{
		"alerts": [
			{
				"policyDisplayNamePrefix": "Smithers High Error Rate",
				"runbook": "docs/runbooks/high-error-rate.md",
				"workflow": ".smithers/workflows/remediate.tsx",
				"remediable": true,
				"maxAutoAttemptsPerDay": 2
			},
			{
				"policyDisplayNamePrefix": "Smithers Certificate Expiry Soon",
				"runbook": "docs/runbooks/certificate-expiry.md",
				"workflow": ".smithers/workflows/remediate.tsx",
				"remediable": false,
				"maxAutoAttemptsPerDay": 0
			}
		]
	}`))
	require.NoError(t, err)
	return registry
}

func newTestAlertIncidentService(q *fakeAlertIncidentQuerier, registry *alertregistry.Registry) *AlertIncidentService {
	svc := NewAlertIncidentService(q, registry)
	svc.now = func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) }
	return svc
}

func TestHandleAlertIncident_ClosedResolvesWithoutEnqueue(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.closed", PolicyName: "Smithers High Error Rate - prod", State: "closed",
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"0.closed"}, q.resolved)
	assert.Empty(t, q.createdIncidents)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_RejectsUnknownState(t *testing.T) {
	t.Parallel()
	q := &fakeAlertIncidentQuerier{}
	err := newTestAlertIncidentService(q, testAlertRegistry(t)).HandleAlertIncident(
		context.Background(),
		MonitoringAlertIncident{IncidentID: "0.invalid", State: "firing"},
	)
	require.Error(t, err)
	assert.Empty(t, q.createdIncidents)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_DuplicateDeliveryIsIdempotent(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{createErr: pgx.ErrNoRows}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.dup", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_RemediablePolicyEnqueuesJob(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.abc", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)
	require.Len(t, q.createdIncidents, 1)
	assert.Equal(t, "docs/runbooks/high-error-rate.md", q.createdIncidents[0].Runbook)
	assert.Equal(t, []int64{1}, q.enqueuedJobs)
}

func TestHandleAlertIncident_NonRemediablePolicyRecordsOnly(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.cert", PolicyName: "Smithers Certificate Expiry Soon - prod", State: "open",
	})
	require.NoError(t, err)
	assert.Len(t, q.createdIncidents, 1)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_UnknownPolicyRecordsOnly(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.unknown", PolicyName: "Some New Policy - prod", State: "open",
	})
	require.NoError(t, err)
	assert.Len(t, q.createdIncidents, 1)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_ActiveIncidentForPolicyDedupes(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{activeForPolicy: 1}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.second", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_DailyAttemptCapSkipsEnqueue(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{attemptsSince: 2}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.capped", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)
	assert.Empty(t, q.enqueuedJobs)
}

func TestRecordRemediationOutcome_PersistsReportURL(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{incidentByID: map[string]clusterdb.AlertIncident{
		"0.abc": {ID: 42, IncidentID: "0.abc"},
	}}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{
		IncidentID: "0.abc",
		State:      "RESOLVED",
		ReportURL:  " https://github.com/smithersai/smithers/blob/main/docs/incidents/report.md ",
	})
	require.NoError(t, err)
	require.Len(t, q.outcomes, 1)
	assert.Equal(t, int64(42), q.outcomes[0].ID)
	assert.Equal(t, "resolved", q.outcomes[0].State)
	assert.Equal(t, "https://github.com/smithersai/smithers/blob/main/docs/incidents/report.md", q.outcomes[0].RemediationPrUrl)
}

func TestRecordRemediationOutcome_AcceptsLegacyPrURLField(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{incidentByID: map[string]clusterdb.AlertIncident{
		"0.abc": {ID: 42, IncidentID: "0.abc"},
	}}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{
		IncidentID: "0.abc", State: "failed", PrURL: " https://github.com/smithersai/smithers/actions/runs/1 ",
	})
	require.NoError(t, err)
	require.Len(t, q.outcomes, 1)
	assert.Equal(t, "failed", q.outcomes[0].State)
	assert.Equal(t, "https://github.com/smithersai/smithers/actions/runs/1", q.outcomes[0].RemediationPrUrl)
}

func TestRecordRemediationOutcome_AlreadyResolvedIsIdempotentNoop(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{
		incidentByID: map[string]clusterdb.AlertIncident{
			"0.abc": {ID: 42, IncidentID: "0.abc", State: "resolved"},
		},
		outcomeAlreadyResolved: true,
	}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{
		IncidentID: "0.abc", State: "failed",
	})
	require.NoError(t, err)
	assert.Empty(t, q.outcomes)
}

func TestRecordRemediationOutcome_RejectsInvalidState(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))

	err := svc.RecordRemediationOutcome(context.Background(), AlertRemediationOutcome{
		IncidentID: "0.abc", State: "merged",
	})
	assert.Error(t, err)
	assert.Empty(t, q.outcomes)
}

func TestRecordWorkflowRemediationOutcome_RequiresExactPersistedBinding(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{
		incidentByID: map[string]clusterdb.AlertIncident{
			"0.bound": {ID: 42, IncidentID: "0.bound"},
		},
		authorizedOutcomeRows: 1,
	}
	svc := newTestAlertIncidentService(q, testAlertRegistry(t))
	run := db.WorkflowRun{
		ID:                   91,
		RepositoryID:         17,
		WorkflowDefinitionID: 23,
		TriggerEvent:         services.AlertRemediationTriggerEvent,
		ExecutionPlane:       services.WorkflowRunPlaneRunner,
		DispatchInputs: []byte(`{
			"incident_row_id": 42,
			"incident_id": "0.bound",
			"remediation_job_id": 73,
			"remediation_dispatch_token": "` + strings.Repeat("a", 64) + `",
			"remediation_repository": "smithers-ai/plue"
		}`),
	}

	claim := AlertRemediationTaskClaim{TaskID: 101, RunnerID: 202, Attempt: 3}
	err := svc.RecordWorkflowRemediationOutcome(context.Background(), run, claim, AlertRemediationOutcome{
		IncidentID: "0.bound",
		State:      "PR_OPENED",
		ReportURL:  " https://github.com/smithers-ai/plue/pull/42 ",
	})
	require.NoError(t, err)
	require.Len(t, q.authorizedOutcome, 1)
	assert.Equal(t, clusterdb.AuthorizeAlertRemediationOutcomeRunParams{
		JobID:                73,
		IncidentRowID:        42,
		DispatchToken:        strings.Repeat("a", 64),
		WorkflowRunID:        pgtype.Int8{Int64: 91, Valid: true},
		TaskID:               101,
		RunnerID:             pgtype.Int8{Int64: 202, Valid: true},
		TaskAttempt:          3,
		ExpectedJob:          "publish",
		IncidentID:           "0.bound",
		RepositoryID:         17,
		WorkflowDefinitionID: 23,
	}, q.authorizedOutcome[0])
	require.Len(t, q.outcomes, 1)
	assert.Equal(t, clusterdb.RecordAlertIncidentRemediationOutcomeGuardedParams{
		ID:               42,
		State:            "pr_opened",
		RemediationPrUrl: "https://github.com/smithers-ai/plue/pull/42",
	}, q.outcomes[0])
}

func TestRecordWorkflowRemediationOutcome_RejectsForgedOrUnboundRuns(t *testing.T) {
	t.Parallel()

	validInputs := []byte(`{
		"incident_row_id": 42,
		"incident_id": "0.bound",
		"remediation_job_id": 73,
		"remediation_dispatch_token": "` + strings.Repeat("b", 64) + `",
		"remediation_repository": "smithers-ai/plue"
	}`)
	validRun := db.WorkflowRun{
		ID: 91, RepositoryID: 17, WorkflowDefinitionID: 23,
		TriggerEvent: services.AlertRemediationTriggerEvent, ExecutionPlane: services.WorkflowRunPlaneRunner,
		DispatchInputs: validInputs,
	}

	for _, tc := range []struct {
		name      string
		mutateRun func(*db.WorkflowRun)
		outcomeID string
	}{
		{name: "missing run id", mutateRun: func(run *db.WorkflowRun) { run.ID = 0 }, outcomeID: "0.bound"},
		{name: "wrong trigger", mutateRun: func(run *db.WorkflowRun) { run.TriggerEvent = "push" }, outcomeID: "0.bound"},
		{name: "wrong execution plane", mutateRun: func(run *db.WorkflowRun) { run.ExecutionPlane = "agent" }, outcomeID: "0.bound"},
		{name: "malformed server inputs", mutateRun: func(run *db.WorkflowRun) { run.DispatchInputs = []byte(`{`) }, outcomeID: "0.bound"},
		{name: "invalid dispatch token", mutateRun: func(run *db.WorkflowRun) {
			run.DispatchInputs = []byte(`{"incident_row_id":42,"incident_id":"0.bound","remediation_job_id":73,"remediation_dispatch_token":"short"}`)
		}, outcomeID: "0.bound"},
		{name: "path incident mismatch", mutateRun: func(*db.WorkflowRun) {}, outcomeID: "0.forged"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := &fakeAlertIncidentQuerier{incidentByID: map[string]clusterdb.AlertIncident{"0.bound": {ID: 42, IncidentID: "0.bound"}}, authorizedOutcomeRows: 1}
			svc := newTestAlertIncidentService(q, testAlertRegistry(t))
			run := validRun
			tc.mutateRun(&run)

			err := svc.RecordWorkflowRemediationOutcome(context.Background(), run, AlertRemediationTaskClaim{TaskID: 101, RunnerID: 202, Attempt: 3}, AlertRemediationOutcome{IncidentID: tc.outcomeID, State: "failed"})
			require.Error(t, err)
			assert.Empty(t, q.authorizedOutcome)
			assert.Empty(t, q.outcomes)
		})
	}
}

func TestRecordWorkflowRemediationOutcome_DatabaseAuthorizationIsFailClosed(t *testing.T) {
	t.Parallel()

	run := db.WorkflowRun{
		ID: 91, RepositoryID: 17, WorkflowDefinitionID: 23,
		TriggerEvent: services.AlertRemediationTriggerEvent, ExecutionPlane: services.WorkflowRunPlaneRunner,
		DispatchInputs: []byte(`{"incident_row_id":42,"incident_id":"0.bound","remediation_job_id":73,"remediation_dispatch_token":"` + strings.Repeat("c", 64) + `","remediation_repository":"smithers-ai/plue"}`),
	}
	for _, tc := range []struct {
		name string
		rows int64
		err  error
	}{
		{name: "no exact relationship", rows: 0},
		{name: "authorization query fails", err: errors.New("database unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := &fakeAlertIncidentQuerier{
				incidentByID:          map[string]clusterdb.AlertIncident{"0.bound": {ID: 42, IncidentID: "0.bound"}},
				authorizedOutcomeRows: tc.rows,
				authorizedOutcomeErr:  tc.err,
			}
			svc := newTestAlertIncidentService(q, testAlertRegistry(t))
			err := svc.RecordWorkflowRemediationOutcome(context.Background(), run, AlertRemediationTaskClaim{TaskID: 101, RunnerID: 202, Attempt: 3}, AlertRemediationOutcome{IncidentID: "0.bound", State: "failed"})
			require.Error(t, err)
			assert.Empty(t, q.outcomes)
		})
	}
}

func TestRecordWorkflowRemediationOutcome_RejectsNonCanonicalPullRequestURLs(t *testing.T) {
	t.Parallel()

	baseRun := db.WorkflowRun{
		ID: 91, RepositoryID: 17, WorkflowDefinitionID: 23,
		TriggerEvent: services.AlertRemediationTriggerEvent, ExecutionPlane: services.WorkflowRunPlaneRunner,
		DispatchInputs: []byte(`{"incident_row_id":42,"incident_id":"0.bound","remediation_job_id":73,"remediation_dispatch_token":"` + strings.Repeat("d", 64) + `","remediation_repository":"smithers-ai/plue"}`),
	}
	for _, rawURL := range []string{
		"http://github.com/smithers-ai/plue/pull/1",
		"https://evil.example/smithers-ai/plue/pull/1",
		"https://github.com/smithers-ai/other/pull/1",
		"https://github.com/smithers-ai/plue/pull/0",
		"https://github.com/smithers-ai/plue/pull/1/files",
		"https://github.com/smithers-ai/plue/pull/1?diff=split",
		"https://github.com/smithers-ai/plue/pull/1#discussion",
		"https://user@github.com/smithers-ai/plue/pull/1",
	} {
		rawURL := rawURL
		t.Run(rawURL, func(t *testing.T) {
			t.Parallel()
			q := &fakeAlertIncidentQuerier{
				incidentByID:          map[string]clusterdb.AlertIncident{"0.bound": {ID: 42, IncidentID: "0.bound"}},
				authorizedOutcomeRows: 1,
			}
			err := newTestAlertIncidentService(q, testAlertRegistry(t)).RecordWorkflowRemediationOutcome(
				context.Background(), baseRun, AlertRemediationTaskClaim{TaskID: 101, RunnerID: 202, Attempt: 3},
				AlertRemediationOutcome{IncidentID: "0.bound", State: "pr_opened", ReportURL: rawURL},
			)
			require.Error(t, err)
			assert.Equal(t, 400, httpStatus(err))
			assert.Empty(t, q.authorizedOutcome, "URL validation must fail before binding or mutating the job")
			assert.Empty(t, q.outcomes)
		})
	}
}

func TestRecordWorkflowRemediationOutcome_FailureCannotPersistAttackerURL(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{
		incidentByID:          map[string]clusterdb.AlertIncident{"0.bound": {ID: 42, IncidentID: "0.bound"}},
		authorizedOutcomeRows: 1,
	}
	run := db.WorkflowRun{
		ID: 91, RepositoryID: 17, WorkflowDefinitionID: 23,
		TriggerEvent: services.AlertRemediationTriggerEvent, ExecutionPlane: services.WorkflowRunPlaneRunner,
		DispatchInputs: []byte(`{"incident_row_id":42,"incident_id":"0.bound","remediation_job_id":73,"remediation_dispatch_token":"` + strings.Repeat("e", 64) + `","remediation_repository":"smithers-ai/plue"}`),
	}
	err := newTestAlertIncidentService(q, testAlertRegistry(t)).RecordWorkflowRemediationOutcome(
		context.Background(), run, AlertRemediationTaskClaim{TaskID: 101, RunnerID: 202, Attempt: 3},
		AlertRemediationOutcome{
			IncidentID: "0.bound",
			State:      "failed",
			ReportURL:  "https://attacker.example/forged-report",
			PrURL:      "https://github.com/attacker/repo/pull/1",
		},
	)
	require.NoError(t, err)
	require.Len(t, q.authorizedOutcome, 1)
	assert.Equal(t, "record-failure", q.authorizedOutcome[0].ExpectedJob)
	require.Len(t, q.outcomes, 1)
	assert.Equal(t, "failed", q.outcomes[0].State)
	assert.Empty(t, q.outcomes[0].RemediationPrUrl)
}

// Alert INGESTION must not depend on the remediation worker. Production ran
// with alertRemediation.enabled=false (the deliberate fail-closed rollout
// default), which left routes.AlertWebhookHandler.Receiver nil, so every Cloud
// Monitoring delivery was answered 503 "alert remediation worker is not ready"
// and the incident was never recorded — no row, nothing in
// /api/admin/system/incidents, no operator-visible trace that an alert fired.
func TestHandleAlertIncident_RecordsIncidentWhenRemediationDisabled(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := NewAlertIncidentService(q, testAlertRegistry(t), WithAlertRemediationEnabled(false))
	svc.now = func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) }

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID:    "0.remediation-off",
		PolicyName:    "Smithers High Error Rate - prod",
		ConditionName: "HTTP 5xx rate > 5%",
		State:         "open",
		Summary:       "error rate is elevated",
	})
	require.NoError(t, err)

	require.Len(t, q.createdIncidents, 1)
	assert.Equal(t, "0.remediation-off", q.createdIncidents[0].IncidentID)
	assert.Equal(t, "docs/runbooks/high-error-rate.md", q.createdIncidents[0].Runbook)
	// Recorded, but never queued for a worker that is not running.
	assert.Empty(t, q.enqueuedJobs)
}

func TestHandleAlertIncident_EnqueuesWhenRemediationEnabled(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := NewAlertIncidentService(q, testAlertRegistry(t), WithAlertRemediationEnabled(true))
	svc.now = func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) }

	err := svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.remediation-on", PolicyName: "Smithers High Error Rate - prod", State: "open",
	})
	require.NoError(t, err)
	require.Len(t, q.createdIncidents, 1)
	assert.Equal(t, []int64{1}, q.enqueuedJobs)
}

// The default must stay "remediation on" so existing callers that pass no
// option keep enqueueing.
func TestNewAlertIncidentService_RemediationDefaultsOn(t *testing.T) {
	t.Parallel()

	q := &fakeAlertIncidentQuerier{}
	svc := NewAlertIncidentService(q, testAlertRegistry(t))
	svc.now = func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) }

	require.NoError(t, svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{
		IncidentID: "0.default", PolicyName: "Smithers High Error Rate - prod", State: "open",
	}))
	assert.Equal(t, []int64{1}, q.enqueuedJobs)
}

func (f *fakeAlertIncidentQuerier) IncrementActiveAlertIncident(_ context.Context, p clusterdb.IncrementActiveAlertIncidentParams) (int64, error) {
	f.dedupeArgs = append(f.dedupeArgs, p)
	return f.dedupeHits, f.dedupeErr
}

func TestHandleAlertIncident_DedupeRefreshesWithoutEnqueue(t *testing.T) {
	q := &fakeAlertIncidentQuerier{dedupeHits: 1}
	svc := NewAlertIncidentService(q, testAlertRegistry(t))
	require.NoError(t, svc.HandleAlertIncident(context.Background(), MonitoringAlertIncident{IncidentID: "canary-repeat", PolicyName: "Smithers High Error Rate - prod", ConditionName: "condition", Summary: "latest", State: "open"}))
	require.Empty(t, q.createdIncidents)
	require.Empty(t, q.enqueuedJobs)
	require.Equal(t, []clusterdb.IncrementActiveAlertIncidentParams{{IncidentID: "canary-repeat", PolicyName: "Smithers High Error Rate - prod", ConditionName: "condition", Summary: "latest"}}, q.dedupeArgs)
}
