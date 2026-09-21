package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
)

type alertRemediationWorkerCovQuerier struct {
	jobs            []db.AlertRemediationJob
	incident        db.AlertIncident
	def             db.WorkflowDefinition
	claimErr        error
	terminalFailed  []int64
	terminalFailErr error
	failExhausted   []int64
	failExhErr      error
	legacyFailed    []int64
	legacyFailErr   error
	doneIDs         []int64
	retries         []db.RetryAlertRemediationJobParams
	retryRows       int64
	retryRowsSet    bool
	retryErr        error
	atomicFails     []db.FailAlertRemediationJobAndIncidentParams
	atomicFailed    bool
	atomicFailSet   bool
	atomicFailErr   error
	states          []db.UpdateAlertIncidentStateGuardedParams
	defPath         string
	getDefErr       error
	getIncErr       error
	existingRun     db.WorkflowRun
	findRunErr      error
	legacyRunExists bool
	legacyRunErr    error
	legacyRunChecks []db.HasLegacyAlertRemediationWorkflowRunParams
	bindRows        int64
	bindErr         error
	binds           []db.BindAlertRemediationJobWorkflowRunAtAttemptParams
}

func (q *alertRemediationWorkerCovQuerier) ClaimAlertRemediationJobs(context.Context, db.ClaimAlertRemediationJobsParams) ([]db.AlertRemediationJob, error) {
	return q.jobs, q.claimErr
}

func (q *alertRemediationWorkerCovQuerier) FailTerminalAlertRemediationIncidents(context.Context) ([]int64, error) {
	return q.terminalFailed, q.terminalFailErr
}

func (q *alertRemediationWorkerCovQuerier) FailExhaustedAlertRemediationJobs(context.Context, db.FailExhaustedAlertRemediationJobsParams) ([]int64, error) {
	return q.failExhausted, q.failExhErr
}

func (q *alertRemediationWorkerCovQuerier) FailCompletedLegacyAlertRemediationIncidents(context.Context) ([]int64, error) {
	return q.legacyFailed, q.legacyFailErr
}

func (q *alertRemediationWorkerCovQuerier) MarkAlertRemediationJobDone(_ context.Context, id int64) error {
	q.doneIDs = append(q.doneIDs, id)
	return nil
}

func (q *alertRemediationWorkerCovQuerier) RetryAlertRemediationJob(_ context.Context, arg db.RetryAlertRemediationJobParams) (int64, error) {
	q.retries = append(q.retries, arg)
	if q.retryErr != nil {
		return 0, q.retryErr
	}
	if q.retryRowsSet {
		return q.retryRows, nil
	}
	return 1, nil
}

func (q *alertRemediationWorkerCovQuerier) FailAlertRemediationJobAndIncident(_ context.Context, arg db.FailAlertRemediationJobAndIncidentParams) (bool, error) {
	q.atomicFails = append(q.atomicFails, arg)
	if q.atomicFailErr != nil {
		return false, q.atomicFailErr
	}
	if q.atomicFailSet {
		return q.atomicFailed, nil
	}
	return true, nil
}

func (q *alertRemediationWorkerCovQuerier) GetAlertIncident(context.Context, int64) (db.AlertIncident, error) {
	if q.getIncErr != nil {
		return db.AlertIncident{}, q.getIncErr
	}
	return q.incident, nil
}

func (q *alertRemediationWorkerCovQuerier) UpdateAlertIncidentStateGuarded(_ context.Context, arg db.UpdateAlertIncidentStateGuardedParams) (int64, error) {
	q.states = append(q.states, arg)
	return 1, nil
}

func (q *alertRemediationWorkerCovQuerier) GetWorkflowDefinitionByPath(_ context.Context, arg db.GetWorkflowDefinitionByPathParams) (db.WorkflowDefinition, error) {
	q.defPath = arg.Path
	if q.getDefErr != nil {
		return db.WorkflowDefinition{}, q.getDefErr
	}
	return q.def, nil
}

func (q *alertRemediationWorkerCovQuerier) FindAlertRemediationWorkflowRun(context.Context, db.FindAlertRemediationWorkflowRunParams) (db.WorkflowRun, error) {
	if q.findRunErr != nil {
		return db.WorkflowRun{}, q.findRunErr
	}
	if q.existingRun.ID == 0 {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	return q.existingRun, nil
}

func (q *alertRemediationWorkerCovQuerier) HasLegacyAlertRemediationWorkflowRun(_ context.Context, arg db.HasLegacyAlertRemediationWorkflowRunParams) (bool, error) {
	q.legacyRunChecks = append(q.legacyRunChecks, arg)
	return q.legacyRunExists, q.legacyRunErr
}

func (q *alertRemediationWorkerCovQuerier) BindAlertRemediationJobWorkflowRunAtAttempt(_ context.Context, arg db.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error) {
	q.binds = append(q.binds, arg)
	if q.bindErr != nil {
		return 0, q.bindErr
	}
	if q.bindRows == 0 {
		return 1, nil
	}
	return q.bindRows, nil
}

type alertRemediationWorkerCovDispatcher struct {
	err   error
	input DispatchForEventInput
	calls int
}

func (d *alertRemediationWorkerCovDispatcher) DispatchForEvent(_ context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	d.calls++
	d.input = input
	definitionID := int64(0)
	if input.WorkflowDefinitionID != nil {
		definitionID = *input.WorkflowDefinitionID
	}
	return []WorkflowRunResult{{WorkflowRunID: 99, WorkflowDefinitionID: definitionID}}, d.err
}

func alertRemediationWorkerCovRegistry(t *testing.T) *alertregistry.Registry {
	t.Helper()
	registry, err := alertregistry.Parse([]byte(`{"alerts":[{"policyDisplayNamePrefix":"Smithers High Error Rate","runbook":"runbook.md","workflow":"wf.tsx","remediable":true,"maxAutoAttemptsPerDay":3}]}`))
	if err != nil {
		t.Fatalf("parse registry: %v", err)
	}
	return registry
}

func TestAlertRemediationWorker_Cov_NewStartAndPollNoops(t *testing.T) {
	worker := NewAlertRemediationWorker(nil, nil, nil, 123)
	if worker.repositoryID != 123 || worker.interval != defaultAlertRemediationWorkerInterval || worker.claimLimit != defaultAlertRemediationWorkerClaimLimit {
		t.Fatalf("worker defaults = %+v", worker)
	}
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatalf("nil PollOnce returned error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	worker.Start(ctx)
}

func TestAlertRemediationWorker_Cov_ProcessSuccessAndFailures(t *testing.T) {
	t.Run("success dispatches and marks remediating", func(t *testing.T) {
		q := &alertRemediationWorkerCovQuerier{
			jobs:     []db.AlertRemediationJob{{ID: 7, IncidentID: 8}},
			incident: db.AlertIncident{ID: 8, IncidentID: "0.abc", PolicyName: "Smithers High Error Rate - prod", Workflow: "", Runbook: "rb"},
			def:      db.WorkflowDefinition{ID: 55},
		}
		dispatcher := &alertRemediationWorkerCovDispatcher{}
		worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerCovRegistry(t), 101)
		if err := worker.PollOnce(context.Background()); err != nil {
			t.Fatalf("PollOnce returned error: %v", err)
		}
		if dispatcher.calls != 1 || dispatcher.input.RepositoryID != 101 || *dispatcher.input.WorkflowDefinitionID != 55 {
			t.Fatalf("dispatch = %+v calls=%d", dispatcher.input, dispatcher.calls)
		}
		if q.defPath != "wf.tsx" || len(q.doneIDs) != 1 || q.doneIDs[0] != 7 {
			t.Fatalf("defPath=%q done=%v", q.defPath, q.doneIDs)
		}
		if len(q.states) != 1 || q.states[0].State != "remediating" {
			t.Fatalf("states = %+v", q.states)
		}
		if dispatcher.input.Event.Inputs["policy_slug"] != "smithers-high-error-rate" {
			t.Fatalf("event inputs = %#v", dispatcher.input.Event.Inputs)
		}
	})

	t.Run("registry changed drops job", func(t *testing.T) {
		q := &alertRemediationWorkerCovQuerier{
			jobs:     []db.AlertRemediationJob{{ID: 1, IncidentID: 2}},
			incident: db.AlertIncident{ID: 2, PolicyName: "Unknown"},
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerCovRegistry(t), 101)
		if err := worker.PollOnce(context.Background()); err != nil {
			t.Fatalf("PollOnce returned error: %v", err)
		}
		if len(q.doneIDs) != 1 || q.doneIDs[0] != 1 {
			t.Fatalf("done = %v", q.doneIDs)
		}
	})

	t.Run("claim and process errors", func(t *testing.T) {
		worker := NewAlertRemediationWorker(&alertRemediationWorkerCovQuerier{claimErr: errors.New("claim failed")}, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerCovRegistry(t), 101)
		err := worker.PollOnce(context.Background())
		if err == nil || !strings.Contains(err.Error(), "claim alert remediation jobs") {
			t.Fatalf("claim err = %v", err)
		}

		q := &alertRemediationWorkerCovQuerier{
			jobs:      []db.AlertRemediationJob{{ID: 9, IncidentID: 10, Attempts: 1}},
			incident:  db.AlertIncident{ID: 10, PolicyName: "Smithers High Error Rate"},
			getDefErr: errors.New("no workflow"),
		}
		worker = NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerCovRegistry(t), 101)
		if err := worker.PollOnce(context.Background()); err != nil {
			t.Fatalf("PollOnce should record job failure and continue: %v", err)
		}
		if len(q.retries) != 1 || len(q.states) != 0 {
			t.Fatalf("retries=%+v states=%+v", q.retries, q.states)
		}
		if q.retries[0].ExpectedAttempts != 1 || q.retries[0].RetryAfterSeconds != 5 {
			t.Fatalf("retry = %+v", q.retries[0])
		}
	})
}
