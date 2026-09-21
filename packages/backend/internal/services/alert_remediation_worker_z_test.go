package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services/alertregistry"
)

type alertRemediationWorkerZQuerier struct {
	jobs            []db.AlertRemediationJob
	claimErr        error
	terminalFailed  []int64
	terminalFailErr error
	failExhausted   []int64
	failExhErr      error
	legacyFailed    []int64
	legacyFailErr   error
	incident        db.AlertIncident
	getIncErr       error
	def             db.WorkflowDefinition
	getDefErr       error
	doneErr         error
	stateErr        error
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
	existingRun     db.WorkflowRun
	recoveredRun    db.WorkflowRun
	findRunCalls    int
	findRunErr      error
	legacyRunExists bool
	legacyRunErr    error
	legacyRunChecks []db.HasLegacyAlertRemediationWorkflowRunParams
	bindRows        int64
	bindErr         error
	binds           []db.BindAlertRemediationJobWorkflowRunAtAttemptParams
}

func (q *alertRemediationWorkerZQuerier) ClaimAlertRemediationJobs(context.Context, db.ClaimAlertRemediationJobsParams) ([]db.AlertRemediationJob, error) {
	return q.jobs, q.claimErr
}

func (q *alertRemediationWorkerZQuerier) FailTerminalAlertRemediationIncidents(context.Context) ([]int64, error) {
	return q.terminalFailed, q.terminalFailErr
}

func (q *alertRemediationWorkerZQuerier) FailExhaustedAlertRemediationJobs(context.Context, db.FailExhaustedAlertRemediationJobsParams) ([]int64, error) {
	return q.failExhausted, q.failExhErr
}

func (q *alertRemediationWorkerZQuerier) FailCompletedLegacyAlertRemediationIncidents(context.Context) ([]int64, error) {
	return q.legacyFailed, q.legacyFailErr
}

func (q *alertRemediationWorkerZQuerier) MarkAlertRemediationJobDone(_ context.Context, id int64) error {
	q.doneIDs = append(q.doneIDs, id)
	return q.doneErr
}

func (q *alertRemediationWorkerZQuerier) RetryAlertRemediationJob(_ context.Context, arg db.RetryAlertRemediationJobParams) (int64, error) {
	q.retries = append(q.retries, arg)
	if q.retryErr != nil {
		return 0, q.retryErr
	}
	if q.retryRowsSet {
		return q.retryRows, nil
	}
	return 1, nil
}

func (q *alertRemediationWorkerZQuerier) FailAlertRemediationJobAndIncident(_ context.Context, arg db.FailAlertRemediationJobAndIncidentParams) (bool, error) {
	q.atomicFails = append(q.atomicFails, arg)
	if q.atomicFailErr != nil {
		return false, q.atomicFailErr
	}
	if q.atomicFailSet {
		return q.atomicFailed, nil
	}
	return true, nil
}

func (q *alertRemediationWorkerZQuerier) GetAlertIncident(context.Context, int64) (db.AlertIncident, error) {
	if q.getIncErr != nil {
		return db.AlertIncident{}, q.getIncErr
	}
	return q.incident, nil
}

func (q *alertRemediationWorkerZQuerier) UpdateAlertIncidentStateGuarded(_ context.Context, arg db.UpdateAlertIncidentStateGuardedParams) (int64, error) {
	q.states = append(q.states, arg)
	if q.stateErr != nil {
		return 0, q.stateErr
	}
	return 1, nil
}

func (q *alertRemediationWorkerZQuerier) GetWorkflowDefinitionByPath(context.Context, db.GetWorkflowDefinitionByPathParams) (db.WorkflowDefinition, error) {
	if q.getDefErr != nil {
		return db.WorkflowDefinition{}, q.getDefErr
	}
	return q.def, nil
}

func (q *alertRemediationWorkerZQuerier) FindAlertRemediationWorkflowRun(context.Context, db.FindAlertRemediationWorkflowRunParams) (db.WorkflowRun, error) {
	q.findRunCalls++
	if q.findRunErr != nil {
		return db.WorkflowRun{}, q.findRunErr
	}
	if q.findRunCalls > 1 && q.recoveredRun.ID != 0 {
		return q.recoveredRun, nil
	}
	if q.existingRun.ID == 0 {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	return q.existingRun, nil
}

func (q *alertRemediationWorkerZQuerier) HasLegacyAlertRemediationWorkflowRun(_ context.Context, arg db.HasLegacyAlertRemediationWorkflowRunParams) (bool, error) {
	q.legacyRunChecks = append(q.legacyRunChecks, arg)
	return q.legacyRunExists, q.legacyRunErr
}

func (q *alertRemediationWorkerZQuerier) BindAlertRemediationJobWorkflowRunAtAttempt(_ context.Context, arg db.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error) {
	q.binds = append(q.binds, arg)
	if q.bindErr != nil {
		return 0, q.bindErr
	}
	if q.bindRows == 0 {
		return 1, nil
	}
	return q.bindRows, nil
}

func alertRemediationWorkerZRegistry(t *testing.T) *alertregistry.Registry {
	t.Helper()
	registry, err := alertregistry.Parse([]byte(`{"alerts":[{"policyDisplayNamePrefix":"Policy","runbook":"runbook.md","workflow":"wf.tsx","remediable":true,"maxAutoAttemptsPerDay":1}]}`))
	require.NoError(t, err)
	return registry
}

func TestAlertRemediationWorker_LegacyRunFencesOpenIncidentDispatch(t *testing.T) {
	q := &alertRemediationWorkerZQuerier{
		incident: db.AlertIncident{
			ID: 81, IncidentID: "legacy-open-incident", State: "open",
			PolicyName: "Policy production", Workflow: "wf.tsx",
		},
		legacyRunExists: true,
	}
	dispatcher := &alertRemediationWorkerCovDispatcher{}
	worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 101)
	job := db.AlertRemediationJob{
		ID: 71, IncidentID: 81, Status: "processing", Attempts: 1,
		DispatchToken: strings.Repeat("7", 64),
	}

	require.NoError(t, worker.processJob(context.Background(), job))
	assert.Zero(t, dispatcher.calls, "a tokenless legacy commit must fence a fresh dispatch even while the incident is still open")
	assert.Equal(t, []db.HasLegacyAlertRemediationWorkflowRunParams{{
		IncidentRowID: "81",
		IncidentID:    "legacy-open-incident",
	}}, q.legacyRunChecks)
	assert.Empty(t, q.binds)
	assert.Empty(t, q.states)
	assert.Empty(t, q.doneIDs)
}

func TestAlertRemediationWorker_Z_StartAndProcessErrorBranches(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	NewAlertRemediationWorker(
		&alertRemediationWorkerZQuerier{claimErr: context.Canceled},
		&alertRemediationWorkerCovDispatcher{},
		alertRemediationWorkerZRegistry(t),
		1,
	).Start(ctx)

	ctx, cancel = context.WithCancel(context.Background())
	q := &alertRemediationWorkerZQuerier{claimErr: errors.New("poll failed")}
	worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)
	worker.interval = time.Millisecond
	worker.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	go worker.Start(ctx)
	time.Sleep(5 * time.Millisecond)
	cancel()

	job := db.AlertRemediationJob{ID: 7, IncidentID: 8}
	worker = NewAlertRemediationWorker(
		&alertRemediationWorkerZQuerier{getIncErr: errors.New("missing incident")},
		&alertRemediationWorkerCovDispatcher{},
		alertRemediationWorkerZRegistry(t),
		1,
	)
	err := worker.processJob(context.Background(), job)
	require.ErrorContains(t, err, "load incident")

	q = &alertRemediationWorkerZQuerier{
		incident: db.AlertIncident{ID: 8, PolicyName: "Unknown"},
		doneErr:  errors.New("done failed"),
	}
	worker = NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)
	err = worker.processJob(context.Background(), job)
	require.ErrorContains(t, err, "mark job done")

	q = &alertRemediationWorkerZQuerier{
		incident:  db.AlertIncident{ID: 8, PolicyName: "Policy - prod"},
		getDefErr: errors.New("definition failed"),
	}
	worker = NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)
	err = worker.processJob(context.Background(), job)
	require.ErrorContains(t, err, "resolve remediation workflow")

	q = &alertRemediationWorkerZQuerier{
		incident: db.AlertIncident{ID: 8, PolicyName: "Policy - prod"},
		def:      db.WorkflowDefinition{ID: 9},
	}
	worker = NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{err: errors.New("dispatch failed")}, alertRemediationWorkerZRegistry(t), 1)
	err = worker.processJob(context.Background(), job)
	require.ErrorContains(t, err, "dispatch remediation workflow")
}

func TestTruncateAlertRemediationError_PreservesUTF8Boundary(t *testing.T) {
	t.Parallel()
	got := truncateAlertRemediationError(strings.Repeat("a", 4095)+"é", 4096)
	assert.True(t, strings.HasSuffix(got, "a"))
	assert.NotContains(t, got, "�")
	assert.LessOrEqual(t, len(got), 4096)
}

// TestProcessJob_PostDispatchAckFailureDoesNotFailJob covers issue #324: once
// DispatchForEvent succeeds, a failure acking the incident state or the job
// as done must never fail the job (which would let the generic PollOnce
// failure handler mark a genuinely-dispatched incident as 'failed'). The job
// remains processing whenever an ack fails so stale-claim recovery can adopt
// the already-committed run and retry the missing acknowledgement.
func TestProcessJob_PostDispatchAckFailureDoesNotFailJob(t *testing.T) {
	t.Parallel()

	job := db.AlertRemediationJob{ID: 7, IncidentID: 8}

	t.Run("incident state ack fails", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			incident: db.AlertIncident{ID: 8, PolicyName: "Policy - prod"},
			def:      db.WorkflowDefinition{ID: 9},
			stateErr: errors.New("state ack failed"),
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)
		err := worker.processJob(context.Background(), job)
		require.NoError(t, err)
		assert.Empty(t, q.doneIDs, "state-ack failure must leave the job reclaimable so the existing run can retry the ack")
	})

	t.Run("job done ack fails", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			incident: db.AlertIncident{ID: 8, PolicyName: "Policy - prod"},
			def:      db.WorkflowDefinition{ID: 9},
			doneErr:  errors.New("done ack failed"),
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)
		err := worker.processJob(context.Background(), job)
		require.NoError(t, err)
		require.Len(t, q.states, 1)
		assert.Equal(t, "remediating", q.states[0].State)
		assert.Empty(t, q.retries, "a post-dispatch ack failure must never route through the job retry path")
		assert.Empty(t, q.atomicFails, "a post-dispatch ack failure must never route through the terminal failure path")
	})
}

func TestAlertRemediationWorker_ProcessErrorUsesBoundedAttemptFences(t *testing.T) {
	t.Parallel()

	t.Run("retry before budget is exhausted", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			jobs:      []db.AlertRemediationJob{{ID: 7, IncidentID: 8, Attempts: 2}},
			getIncErr: errors.New("temporary incident read failure"),
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

		require.NoError(t, worker.PollOnce(context.Background()))
		require.Len(t, q.retries, 1)
		assert.Equal(t, int64(7), q.retries[0].ID)
		assert.Equal(t, int32(2), q.retries[0].ExpectedAttempts)
		assert.Equal(t, 10.0, q.retries[0].RetryAfterSeconds)
		assert.Contains(t, q.retries[0].Error, "temporary incident read failure")
		assert.Empty(t, q.atomicFails)
		assert.Empty(t, q.states)
	})

	t.Run("terminal failure is atomic at the attempt budget", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			jobs:      []db.AlertRemediationJob{{ID: 9, IncidentID: 10, Attempts: 3}},
			getIncErr: errors.New("permanent incident read failure"),
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

		require.NoError(t, worker.PollOnce(context.Background()))
		require.Len(t, q.atomicFails, 1)
		assert.Equal(t, int64(9), q.atomicFails[0].ID)
		assert.Equal(t, int32(3), q.atomicFails[0].ExpectedAttempts)
		assert.Contains(t, q.atomicFails[0].Error, "permanent incident read failure")
		assert.Empty(t, q.retries)
		assert.Empty(t, q.states)
	})

	t.Run("stale claim generation cannot mutate a newer attempt", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			jobs:         []db.AlertRemediationJob{{ID: 11, IncidentID: 12, Attempts: 1}},
			getIncErr:    errors.New("read failure"),
			retryRowsSet: true,
			retryRows:    0,
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

		require.NoError(t, worker.PollOnce(context.Background()))
		require.Len(t, q.retries, 1)
		assert.Empty(t, q.atomicFails)
		assert.Empty(t, q.states)
	})

	t.Run("database error retains processing state for visibility recovery", func(t *testing.T) {
		q := &alertRemediationWorkerZQuerier{
			jobs:          []db.AlertRemediationJob{{ID: 13, IncidentID: 14, Attempts: 3}},
			getIncErr:     errors.New("read failure"),
			atomicFailErr: errors.New("database unavailable"),
		}
		worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

		require.NoError(t, worker.PollOnce(context.Background()))
		require.Len(t, q.atomicFails, 1)
		assert.Empty(t, q.states)
	})
}

func TestAlertRemediationRetryDelayIsBounded(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 5*time.Second, alertRemediationRetryDelay(0))
	assert.Equal(t, 5*time.Second, alertRemediationRetryDelay(1))
	assert.Equal(t, 10*time.Second, alertRemediationRetryDelay(2))
	assert.Equal(t, 160*time.Second, alertRemediationRetryDelay(10))
}

// TestProcessJob_SkipsTerminalIncident covers issue #295: an incident that
// already reached a terminal state (resolved or failed) through another path
// must never be resurrected by a stale/reclaimed job — no dispatch, no
// incident-state write, just an idempotent job-done ack.
func TestProcessJob_SkipsTerminalIncident(t *testing.T) {
	t.Parallel()

	for _, state := range []string{"resolved", "failed"} {
		t.Run(state, func(t *testing.T) {
			job := db.AlertRemediationJob{ID: 7, IncidentID: 8}
			q := &alertRemediationWorkerZQuerier{
				incident: db.AlertIncident{ID: 8, PolicyName: "Policy - prod", State: state},
			}
			dispatcher := &alertRemediationWorkerCovDispatcher{}
			worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 1)

			err := worker.processJob(context.Background(), job)
			require.NoError(t, err)
			assert.Zero(t, dispatcher.calls, "a terminal incident must never be dispatched")
			assert.Empty(t, q.states, "a terminal incident's state must never be written")
			assert.Equal(t, []int64{7}, q.doneIDs)
		})
	}
}

// TestProcessJob_SkipsAlreadyRemediatingIncident covers the legacy rollout
// path: a job reclaimed after a pre-binding dispatch must not trigger a second
// run or be acknowledged done before the legacy terminal reconciler can close
// the incident.
func TestProcessJob_SkipsAlreadyRemediatingIncident(t *testing.T) {
	t.Parallel()

	for _, state := range []string{"remediating", "pr_opened"} {
		t.Run(state, func(t *testing.T) {
			job := db.AlertRemediationJob{ID: 7, IncidentID: 8}
			q := &alertRemediationWorkerZQuerier{
				incident: db.AlertIncident{ID: 8, PolicyName: "Policy - prod", State: state},
			}
			dispatcher := &alertRemediationWorkerCovDispatcher{}
			worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 1)

			err := worker.processJob(context.Background(), job)
			require.NoError(t, err)
			assert.Zero(t, dispatcher.calls, "an already-dispatched incident must not be dispatched again")
			assert.Empty(t, q.doneIDs, "an unbound legacy job must remain visible to terminal reconciliation")
		})
	}
}

func TestPollOnce_LegacyReconciliationErrorPropagates(t *testing.T) {
	t.Parallel()

	q := &alertRemediationWorkerZQuerier{legacyFailErr: errors.New("legacy reconciliation failed")}
	worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

	err := worker.PollOnce(context.Background())
	require.ErrorContains(t, err, "reconcile terminal legacy alert remediation runs")
}

func TestPollOnce_TerminalRunReconciliationErrorPropagates(t *testing.T) {
	t.Parallel()

	q := &alertRemediationWorkerZQuerier{terminalFailErr: errors.New("terminal reconciliation failed")}
	worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

	err := worker.PollOnce(context.Background())
	require.ErrorContains(t, err, "reconcile terminal alert remediation runs")
}

// TestPollOnce_FailsExhaustedJobsAndMarksIncidents covers issue #21: exhausted
// jobs and their incidents are terminalized atomically by the DB query, so the
// worker must not issue a second best-effort incident update.
func TestPollOnce_FailsExhaustedJobsAndMarksIncidents(t *testing.T) {
	t.Parallel()

	q := &alertRemediationWorkerZQuerier{
		failExhausted: []int64{8, 9},
	}
	worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, q.states)
}

// TestPollOnce_FailExhaustedErrorPropagates ensures a DB error while
// terminalizing exhausted jobs surfaces to the caller instead of being
// silently swallowed.
func TestPollOnce_FailExhaustedErrorPropagates(t *testing.T) {
	t.Parallel()

	q := &alertRemediationWorkerZQuerier{failExhErr: errors.New("fail exhausted query failed")}
	worker := NewAlertRemediationWorker(q, &alertRemediationWorkerCovDispatcher{}, alertRemediationWorkerZRegistry(t), 1)

	err := worker.PollOnce(context.Background())
	require.ErrorContains(t, err, "fail exhausted alert remediation jobs")
}

func TestProcessJob_RecoversCommittedRunWithoutRedispatch(t *testing.T) {
	t.Parallel()

	job := db.AlertRemediationJob{
		ID:            7,
		IncidentID:    8,
		DispatchToken: strings.Repeat("a", 64),
	}
	q := &alertRemediationWorkerZQuerier{
		incident:    db.AlertIncident{ID: 8, IncidentID: "inc-8", PolicyName: "Policy - prod"},
		def:         db.WorkflowDefinition{ID: 9},
		existingRun: db.WorkflowRun{ID: 77, WorkflowDefinitionID: 9},
	}
	dispatcher := &alertRemediationWorkerCovDispatcher{}
	worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 1)

	require.NoError(t, worker.processJob(context.Background(), job))
	assert.Zero(t, dispatcher.calls)
	require.Len(t, q.binds, 1)
	assert.Equal(t, int64(77), q.binds[0].WorkflowRunID.Int64)
	assert.Equal(t, []int64{7}, q.doneIDs)
	require.Len(t, q.states, 1)
	assert.Equal(t, "remediating", q.states[0].State)
}

func TestProcessJob_BindFailureIsRecoveredWithoutDuplicateDispatch(t *testing.T) {
	t.Parallel()

	job := db.AlertRemediationJob{
		ID:            7,
		IncidentID:    8,
		DispatchToken: strings.Repeat("b", 64),
	}
	q := &alertRemediationWorkerZQuerier{
		incident: db.AlertIncident{ID: 8, IncidentID: "inc-8", PolicyName: "Policy - prod"},
		def:      db.WorkflowDefinition{ID: 9},
		bindErr:  errors.New("bind unavailable"),
	}
	dispatcher := &alertRemediationWorkerCovDispatcher{}
	worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 1)

	// The workflow run is already committed when the bind fails. Do not mark the
	// job done or the incident remediating: a stale-claim retry must adopt it.
	require.NoError(t, worker.processJob(context.Background(), job))
	require.Equal(t, 1, dispatcher.calls)
	assert.Empty(t, q.doneIDs)
	assert.Empty(t, q.states)

	// Simulate the stale-claim retry finding that committed run by its persisted
	// job token. It binds and acknowledges without invoking DispatchForEvent.
	q.bindErr = nil
	q.existingRun = db.WorkflowRun{ID: 99, WorkflowDefinitionID: 9}
	require.NoError(t, worker.processJob(context.Background(), job))
	assert.Equal(t, 1, dispatcher.calls)
	assert.Equal(t, []int64{7}, q.doneIDs)
	assert.Len(t, q.binds, 2)
	assert.Equal(t, int64(99), q.binds[1].WorkflowRunID.Int64)
}

func TestProcessJob_AdoptsConcurrentDispatchWinnerAfterInsertConflict(t *testing.T) {
	t.Parallel()

	job := db.AlertRemediationJob{ID: 7, IncidentID: 8, DispatchToken: strings.Repeat("c", 64)}
	q := &alertRemediationWorkerZQuerier{
		incident:     db.AlertIncident{ID: 8, IncidentID: "inc-8", PolicyName: "Policy - prod"},
		def:          db.WorkflowDefinition{ID: 9},
		recoveredRun: db.WorkflowRun{ID: 101, WorkflowDefinitionID: 9},
	}
	dispatcher := &alertRemediationWorkerCovDispatcher{err: errors.New("duplicate remediation dispatch token")}
	worker := NewAlertRemediationWorker(q, dispatcher, alertRemediationWorkerZRegistry(t), 1)

	require.NoError(t, worker.processJob(context.Background(), job))
	assert.Equal(t, 1, dispatcher.calls)
	assert.Equal(t, 2, q.findRunCalls)
	require.Len(t, q.binds, 1)
	assert.Equal(t, int64(101), q.binds[0].WorkflowRunID.Int64)
	assert.Equal(t, []int64{7}, q.doneIDs)
}
