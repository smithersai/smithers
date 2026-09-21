package db

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowLogsSQLHDB = chunk5SQLHDB
type workflowLogsSQLHRow = chunk5SQLHRow
type workflowLogsSQLHRows = chunk5SQLHRows

func TestWorkflowLogsSQL_H_RuntimeAndLogsRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	repoID, runID, stepID := workflowLogsSQLHCreateFixture(t, q, pool)

	run, err := q.GetWorkflowRunByIDAndRepo(ctx, GetWorkflowRunByIDAndRepoParams{RunID: runID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, runID, run.ID)
	_, err = q.GetWorkflowRunByIDAndRepo(ctx, GetWorkflowRunByIDAndRepoParams{RunID: runID, RepositoryID: repoID + 9999})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	assigned, err := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
		WorkflowRunID: runID, WorkflowStepID: stepID, RepositoryID: repoID, Status: "assigned", Priority: 1, Payload: json.RawMessage(`{"kind":"assigned"}`),
	})
	require.NoError(t, err)
	runtimeCtx, err := q.GetWorkflowTaskRuntimeContext(ctx, GetWorkflowTaskRuntimeContextParams{TaskID: assigned.ID, WorkflowRunID: runID})
	require.NoError(t, err)
	assert.Equal(t, "assigned", runtimeCtx.Status)

	done, err := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
		WorkflowRunID: runID, WorkflowStepID: stepID, RepositoryID: repoID, Status: "done", Priority: 1, Payload: json.RawMessage(`{"kind":"done"}`),
	})
	require.NoError(t, err)
	_, err = q.GetWorkflowTaskRuntimeContext(ctx, GetWorkflowTaskRuntimeContextParams{TaskID: done.ID, WorkflowRunID: runID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	log1, err := q.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stdout", Entry: "hello"})
	require.NoError(t, err)
	assert.Equal(t, int64(1), log1.Sequence)
	log2, err := q.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stderr", Entry: "again"})
	require.NoError(t, err)
	assert.Equal(t, int64(2), log2.Sequence)

	runLog1, err := q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "system", Entry: "run hello"})
	require.NoError(t, err)
	assert.Equal(t, int64(1), runLog1.Sequence)
	runLog2, err := q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stdout", Entry: "run again"})
	require.NoError(t, err)
	assert.Equal(t, int64(2), runLog2.Sequence)

	logs, err := q.ListWorkflowLogsSince(ctx, ListWorkflowLogsSinceParams{RunID: runID, AfterID: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, logs, 4)
	assert.Equal(t, []int64{log1.ID, log2.ID, runLog1.ID, runLog2.ID}, []int64{logs[0].ID, logs[1].ID, logs[2].ID, logs[3].ID})
	afterFirst, err := q.ListWorkflowLogsSince(ctx, ListWorkflowLogsSinceParams{RunID: runID, AfterID: log1.ID, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, afterFirst, 3)
	assert.Equal(t, log2.ID, afterFirst[0].ID)

	steps, err := q.ListWorkflowStepsByRunID(ctx, runID)
	require.NoError(t, err)
	require.Len(t, steps, 1)
	assert.Equal(t, stepID, steps[0].ID)
	emptyLogs, err := q.ListWorkflowLogsSince(ctx, ListWorkflowLogsSinceParams{RunID: runID, AfterID: runLog2.ID, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyLogs)

	require.NoError(t, q.NotifyWorkflowRunLog(ctx, NotifyWorkflowRunLogParams{RunID: runID, Payload: `{"ok":true}`}))
	require.NoError(t, q.NotifyWorkflowLog(ctx, NotifyWorkflowLogParams{StepID: stepID, Payload: `{"ok":true}`}))
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "bogus", Entry: "bad"})
		return err
	})
}

func TestWorkflowLogsSQL_H_CumulativeBudgetSpansBothLogTables(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, pool)
	secondStep, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{
		WorkflowRunID: runID,
		Name:          "budget-second-step",
		Position:      2,
		Status:        "queued",
	})
	require.NoError(t, err)

	// Put the authoritative counter eight bytes below the production ceiling.
	// Five step-log bytes plus three whole-run-log bytes exactly meet the shared
	// budget. A subsequent insert through either table must be rejected,
	// including on a different step in the same run.
	_, err = pool.Exec(ctx, `
		UPDATE workflow_runs
		SET log_bytes = 52428800 - 8,
		    log_entry_count = 0
		WHERE id = $1
	`, runID)
	require.NoError(t, err)
	_, err = q.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{
		WorkflowRunID:  runID,
		WorkflowStepID: stepID,
		Stream:         "stdout",
		Entry:          "12345",
	})
	require.NoError(t, err)
	_, err = q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{
		WorkflowRunID:  runID,
		WorkflowStepID: stepID,
		Stream:         "system",
		Entry:          "678",
	})
	require.NoError(t, err)
	err = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, insertErr := spQ.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{
			WorkflowRunID:  runID,
			WorkflowStepID: secondStep.ID,
			Stream:         "stderr",
			Entry:          "x",
		})
		return insertErr
	})
	requireWorkflowLogBudgetError(t, err)

	var storedBytes int64
	var counterBytes int64
	var counterEntries int64
	err = pool.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT SUM(OCTET_LENGTH(entry)) FROM workflow_logs WHERE workflow_run_id = $1), 0)
			+ COALESCE((SELECT SUM(OCTET_LENGTH(entry)) FROM workflow_run_logs WHERE workflow_run_id = $1), 0),
			log_bytes,
			log_entry_count
		FROM workflow_runs
		WHERE id = $1
	`, runID).Scan(&storedBytes, &counterBytes, &counterEntries)
	require.NoError(t, err)
	assert.Equal(t, int64(8), storedBytes)
	assert.Equal(t, int64(52428800), counterBytes)
	assert.Equal(t, int64(2), counterEntries)
}

func TestWorkflowLogsSQL_H_ZeroByteEntryBudgetCoversDirectWriters(t *testing.T) {
	ctx := context.Background()
	_, pool := newQueries(t)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, New(pool), pool)
	_, err := pool.Exec(ctx, `
		UPDATE workflow_runs
		SET log_bytes = 0,
		    log_entry_count = 99999
		WHERE id = $1
	`, runID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO workflow_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
		VALUES ($1, $2, 1, 'stdout', '')
	`, runID, stepID)
	require.NoError(t, err)

	err = mustExpectError(t, pool, func(sp DBTX) error {
		_, insertErr := sp.Exec(ctx, `
			INSERT INTO workflow_run_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
			VALUES ($1, $2, 1, 'system', '')
		`, runID, stepID)
		return insertErr
	})
	requireWorkflowLogBudgetError(t, err)

	err = mustExpectError(t, pool, func(sp DBTX) error {
		_, updateErr := sp.Exec(ctx, `UPDATE workflow_logs SET entry = 'bypass' WHERE workflow_run_id = $1`, runID)
		return updateErr
	})
	require.Error(t, err)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "23514", pgErr.Code, "entry updates cannot bypass the insert-time counter")
}

func TestWorkflowLogsSQL_H_CounterRollsBackOnSavepointAndDuplicateThenAllowsRunCascade(t *testing.T) {
	ctx := context.Background()
	q, txDB := newQueries(t)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, txDB)

	first, err := q.InsertWorkflowLog(ctx, InsertWorkflowLogParams{
		WorkflowRunID: runID, WorkflowStepID: stepID, Sequence: 1, Stream: "stdout", Entry: "abc",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), first.Sequence)
	assertWorkflowLogCounters(t, txDB, runID, 3, 1)

	tx := txDB.(pgx.Tx)
	sp, err := tx.Begin(ctx)
	require.NoError(t, err)
	spQ := New(sp)
	_, err = spQ.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{
		WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "system", Entry: "rollback",
	})
	require.NoError(t, err)
	require.NoError(t, sp.Rollback(ctx))
	assertWorkflowLogCounters(t, txDB, runID, 3, 1)

	err = mustExpectQueryError(t, txDB, func(spQ *Queries) error {
		_, insertErr := spQ.InsertWorkflowLog(ctx, InsertWorkflowLogParams{
			WorkflowRunID: runID, WorkflowStepID: stepID, Sequence: 1, Stream: "stderr", Entry: "duplicate",
		})
		return insertErr
	})
	require.Error(t, err)
	var duplicateErr *pgconn.PgError
	require.ErrorAs(t, err, &duplicateErr)
	assert.Equal(t, "23505", duplicateErr.Code)
	assertWorkflowLogCounters(t, txDB, runID, 3, 1)

	_, err = txDB.Exec(ctx, `DELETE FROM workflow_runs WHERE id = $1`, runID)
	require.NoError(t, err, "child log release triggers must not interfere with parent cascade")
	var remaining int64
	require.NoError(t, txDB.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_logs WHERE workflow_run_id = $1`, runID).Scan(&remaining))
	assert.Zero(t, remaining)
}

func TestWorkflowLogsSQL_H_MixedTableConcurrentAdmissionIsAtomic(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, sharedPool)
	_, err := sharedPool.Exec(ctx, `
		UPDATE workflow_runs
		SET log_bytes = 52428800 - 1,
		    log_entry_count = 0
		WHERE id = $1
	`, runID)
	require.NoError(t, err)

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, insertErr := q.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{
			WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stdout", Entry: "a",
		})
		errs <- insertErr
	}()
	go func() {
		defer wg.Done()
		<-start
		_, insertErr := q.InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{
			WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "system", Entry: "b",
		})
		errs <- insertErr
	}()
	close(start)
	wg.Wait()
	close(errs)

	var successes int
	var limited int
	for insertErr := range errs {
		if insertErr == nil {
			successes++
			continue
		}
		var pgErr *pgconn.PgError
		require.ErrorAs(t, insertErr, &pgErr)
		if pgErr.Code == "54000" && pgErr.ConstraintName == "workflow_run_log_budget" {
			limited++
		}
	}
	assert.Equal(t, 1, successes)
	assert.Equal(t, 1, limited)
	assertWorkflowLogCounters(t, sharedPool, runID, 52428800, 1)
}

func TestWorkflowLogsSQL_H_BackfillPreservesPreexistingOverBudgetUsage(t *testing.T) {
	ctx := context.Background()
	_, txDB := newQueries(t)
	q := New(txDB)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, txDB)

	// Model a legacy run: it has no initialization marker, so historical writes
	// remain admissible and do not mutate the new counters until its bounded
	// one-run recount establishes an exact baseline.
	_, err := txDB.Exec(ctx, `
		DELETE FROM workflow_log_budget_initializations
		WHERE workflow_run_id = $1
	`, runID)
	require.NoError(t, err)
	_, err = txDB.Exec(ctx, `
		INSERT INTO workflow_logs (workflow_run_id, workflow_step_id, sequence, stream, entry)
		VALUES ($1, $2, 1, 'stdout', repeat('x', 52428801))
	`, runID, stepID)
	require.NoError(t, err)
	assertWorkflowLogCounters(t, txDB, runID, 0, 0)

	backfilledRunID, err := q.BackfillOneWorkflowLogBudget(ctx)
	require.NoError(t, err)
	assert.Equal(t, runID, backfilledRunID)
	assertWorkflowLogCounters(t, txDB, runID, 52428801, 1)
	var initialized bool
	require.NoError(t, txDB.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workflow_log_budget_initializations
			WHERE workflow_run_id = $1
		)
	`, runID).Scan(&initialized))
	assert.True(t, initialized)

	err = mustExpectQueryError(t, txDB, func(spQ *Queries) error {
		_, insertErr := spQ.InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{
			WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stderr", Entry: "",
		})
		return insertErr
	})
	requireWorkflowLogBudgetError(t, err)
}

func assertWorkflowLogCounters(t *testing.T, tx DBTX, runID, wantBytes, wantEntries int64) {
	t.Helper()
	var logBytes int64
	var logEntries int64
	require.NoError(t, tx.QueryRow(context.Background(), `
		SELECT log_bytes, log_entry_count
		FROM workflow_runs
		WHERE id = $1
	`, runID).Scan(&logBytes, &logEntries))
	assert.Equal(t, wantBytes, logBytes)
	assert.Equal(t, wantEntries, logEntries)
}

func requireWorkflowLogBudgetError(t *testing.T, err error) {
	t.Helper()
	require.Error(t, err)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "54000", pgErr.Code)
	assert.Equal(t, "workflow_run_log_budget", pgErr.ConstraintName)
}

func TestWorkflowLogsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow logs h failed")
	listCases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListWorkflowLogsSince", func(q *Queries) error {
			_, err := q.ListWorkflowLogsSince(context.Background(), ListWorkflowLogsSinceParams{RunID: 1, PageSize: 1})
			return err
		}},
		{"ListWorkflowStepsByRunID", func(q *Queries) error {
			_, err := q.ListWorkflowStepsByRunID(context.Background(), 1)
			return err
		}},
	}
	for _, tc := range listCases {
		require.ErrorIs(t, tc.call(New(workflowLogsSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(workflowLogsSQLHDB{rows: &workflowLogsSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(workflowLogsSQLHDB{rows: &workflowLogsSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}

	rowQ := New(workflowLogsSQLHDB{row: workflowLogsSQLHRow{err: sentinel}})
	_, err := rowQ.GetWorkflowRunByIDAndRepo(context.Background(), GetWorkflowRunByIDAndRepoParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetWorkflowTaskRuntimeContext(context.Background(), GetWorkflowTaskRuntimeContextParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.InsertWorkflowLogNextSequence(context.Background(), InsertWorkflowLogNextSequenceParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.InsertWorkflowRunLogNextSequence(context.Background(), InsertWorkflowRunLogNextSequenceParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(workflowLogsSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.NotifyWorkflowRunLog(context.Background(), NotifyWorkflowRunLogParams{}), sentinel)
}

func workflowLogsSQLHCreateFixture(t *testing.T, q *Queries, pool DBTX) (int64, int64, int64) {
	t.Helper()
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "workflow-logs-h",
		Path:         ".smithers/workflows/logs-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{"steps":[{"name":"test"}]}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID: repoID, WorkflowDefinitionID: def.ID, Status: "queued", TriggerEvent: "push", TriggerRef: "main", TriggerCommitSha: "sha-" + randSlug(t),
	})
	require.NoError(t, err)
	step, err := q.CreateWorkflowStep(context.Background(), CreateWorkflowStepParams{WorkflowRunID: run.ID, Name: "test", Position: 1, Status: "queued"})
	require.NoError(t, err)
	return repoID, run.ID, step.ID
}
