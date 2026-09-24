package clusterservices

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type zRunnerTxStarter struct {
	tx  pgx.Tx
	err error
}

func (s zRunnerTxStarter) BeginTx(context.Context) (pgx.Tx, error) {
	return s.tx, s.err
}

type zRunnerTx struct {
	pgx.Tx
	execErr   error
	commitErr error
	row       db.InsertWorkflowLogNextSequenceRow
	rowErr    error
}

func (tx *zRunnerTx) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, tx.execErr
}

func (tx *zRunnerTx) Commit(context.Context) error {
	return tx.commitErr
}

func (tx *zRunnerTx) Rollback(context.Context) error {
	return nil
}

func (tx *zRunnerTx) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return zRunnerLogRow{row: tx.row, err: tx.rowErr}
}

type zRunnerLogRow struct {
	row db.InsertWorkflowLogNextSequenceRow
	err error
}

func (r zRunnerLogRow) Scan(dest ...interface{}) error {
	if r.err != nil {
		return r.err
	}
	values := []interface{}{
		r.row.ID,
		r.row.WorkflowRunID,
		r.row.WorkflowStepID,
		r.row.Sequence,
		r.row.Stream,
		r.row.Entry,
		r.row.CreatedAt,
	}
	for i := range dest {
		switch ptr := dest[i].(type) {
		case *int64:
			*ptr = values[i].(int64)
		case *string:
			*ptr = values[i].(string)
		case *time.Time:
			*ptr = values[i].(time.Time)
		default:
			panic("unexpected scan destination")
		}
	}
	return nil
}

type zRunnerQuerierOnly struct {
	RunnerQuerier
}

type zRunnerResolverOnly struct {
	RunnerQuerier
	repoFn func(context.Context, int64) (db.Repository, error)
	userFn func(context.Context, int64) (db.User, error)
	orgFn  func(context.Context, int64) (db.Organization, error)
}

func (q zRunnerResolverOnly) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	return q.repoFn(ctx, id)
}

func (q zRunnerResolverOnly) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	return q.userFn(ctx, id)
}

func (q zRunnerResolverOnly) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	return q.orgFn(ctx, id)
}

func TestRunner_Z_BasicValidationAndStoreErrors(t *testing.T) {
	svc := NewRunnerService(nil)

	_, err := svc.ClaimTask(context.Background(), 1)
	require.Equal(t, 500, runnerAPIStatus(t, err))
	require.Equal(t, 400, runnerAPIStatus(t, svc.Heartbeat(context.Background(), 0)))
	require.Equal(t, 500, runnerAPIStatus(t, svc.Heartbeat(context.Background(), 1)))
	require.Equal(t, 400, runnerAPIStatus(t, svc.Terminate(context.Background(), 0)))
	require.Equal(t, 500, runnerAPIStatus(t, svc.Terminate(context.Background(), 1)))
	_, err = svc.GetTaskRuntimeEnvironment(context.Background(), 0)
	require.Equal(t, 400, runnerAPIStatus(t, err))
	_, err = svc.GetTaskRuntimeEnvironment(context.Background(), 1)
	require.Equal(t, 500, runnerAPIStatus(t, err))
	require.Equal(t, 400, runnerAPIStatus(t, svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 0, RunnerID: 1, Status: "done"})))
	require.Equal(t, 400, runnerAPIStatus(t, svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 0, Status: "done"})))
}

func TestRunner_Z_ClaimHeartbeatTerminateBranches(t *testing.T) {
	boom := errors.New("boom")

	_, err := NewRunnerService(&mockRunnerQuerier{
		claimIdleRunnerFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, pgx.ErrNoRows
		},
	}).ClaimTask(context.Background(), 7)
	require.Equal(t, 409, runnerAPIStatus(t, err))

	_, err = NewRunnerService(&mockRunnerQuerier{
		claimIdleRunnerFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, boom
		},
	}).ClaimTask(context.Background(), 7)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	_, err = NewRunnerService(&mockRunnerQuerier{
		claimPendingTaskFn: func(context.Context, pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			return 0, boom
		},
	}).ClaimTask(context.Background(), 7)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	released := false
	_, err = NewRunnerService(&mockRunnerQuerier{
		claimPendingTaskFn: func(context.Context, pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, boom
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			released = true
			return 1, nil
		},
	}).ClaimTask(context.Background(), 7)
	require.True(t, released)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	_, err = NewRunnerService(&mockRunnerQuerier{
		claimPendingTaskFn: func(context.Context, pgtype.Int8) (db.WorkflowTask, error) {
			return db.WorkflowTask{ID: 9, WorkflowRunID: 10, WorkflowStepID: 11, RepositoryID: 12}, nil
		},
		markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
			return 0, nil
		},
		releaseRunnerFn: func(context.Context, int64) (int64, error) {
			released = true
			return 1, nil
		},
	}).ClaimTask(context.Background(), 7)
	require.Equal(t, 409, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		touchRunnerHeartbeatFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, boom
		},
	}).Heartbeat(context.Background(), 7)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		terminateRunnerFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, pgx.ErrNoRows
		},
	}).Terminate(context.Background(), 7)
	require.Equal(t, 404, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		terminateRunnerFn: func(context.Context, int64) (clusterdb.RunnerPool, error) {
			return clusterdb.RunnerPool{}, boom
		},
	}).Terminate(context.Background(), 7)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		requeueTasksForRunnerFn: func(context.Context, pgtype.Int8) (int64, error) {
			return 0, boom
		},
	}).Terminate(context.Background(), 7)
	require.Equal(t, 500, runnerAPIStatus(t, err))
}

func TestRunner_Z_MarkTaskRunningBranches(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name string
		q    *mockRunnerQuerier
		code int
	}{
		{
			name: "mark error",
			q: &mockRunnerQuerier{
				markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
					return 0, boom
				},
			},
			code: 500,
		},
		{
			name: "zero rows",
			q: &mockRunnerQuerier{
				markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
					return 0, nil
				},
			},
			code: 409,
		},
		{
			name: "step id error",
			q: &mockRunnerQuerier{
				markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
					return 1, nil
				},
				getWorkflowTaskStepIDFn: func(context.Context, int64) (int64, error) {
					return 0, boom
				},
			},
			code: 500,
		},
		{
			name: "step status error",
			q: &mockRunnerQuerier{
				markWorkflowTaskRunningFn: func(context.Context, db.MarkWorkflowTaskRunningParams) (int64, error) {
					return 1, nil
				},
				getWorkflowTaskStepIDFn: func(context.Context, int64) (int64, error) {
					return 44, nil
				},
				updateWorkflowStepStatusRunningFn: func(context.Context, int64) (int64, error) {
					return 0, boom
				},
			},
			code: 500,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := (&runnerService{queries: tc.q}).markTaskRunning(context.Background(), 3, 4)
			require.Equal(t, tc.code, runnerAPIStatus(t, err))
		})
	}
}

func TestRunner_Z_RuntimeAndStreamBranches(t *testing.T) {
	boom := errors.New("boom")
	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 100})
	ctx = middleware.ContextWithAgentToken(ctx, "smithers_agent_z_token")

	_, err := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(context.Context, db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			return db.GetWorkflowTaskRuntimeContextRow{}, boom
		},
	}).GetTaskRuntimeEnvironment(ctx, 5)
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{}, boom
		},
	}).StreamEvents(context.Background(), RunnerStreamEventsInput{TaskID: 1})
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{ID: 1, WorkflowRunID: 100, WorkflowStepID: 2, RepositoryID: 9}, nil
		},
	}, WithRunnerSecretInjector(services.NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, boom
		},
	}, webhook.NoopSecretCodec{}))).StreamEvents(ctx, RunnerStreamEventsInput{TaskID: 1, Events: []RunnerEvent{{Type: "log", Data: []byte(`{}`)}}})
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{ID: 1, WorkflowRunID: 100, WorkflowStepID: 2, RepositoryID: 9}, nil
		},
	}).StreamEvents(ctx, RunnerStreamEventsInput{TaskID: 1, Events: []RunnerEvent{{Type: "log", Data: []byte(`{`)}}})
	require.Equal(t, 400, runnerAPIStatus(t, err))
}

func TestRunner_Z_LogTransactionAndInsertBranches(t *testing.T) {
	boom := errors.New("boom")
	task := db.GetWorkflowTaskForRunnerRow{ID: 1, WorkflowRunID: 10, WorkflowStepID: 20}
	logs := []parsedRunnerLogEvent{{stream: "stdout", text: "hello"}}
	svc := &runnerService{queries: &mockRunnerQuerier{}}

	require.Equal(t, 500, runnerAPIStatus(t, svc.streamLogEventsWithTx(context.Background(), zRunnerTxStarter{err: boom}, task, logs)))
	require.Equal(t, 500, runnerAPIStatus(t, svc.streamLogEventsWithTx(context.Background(), zRunnerTxStarter{tx: &zRunnerTx{execErr: boom}}, task, logs)))
	require.Equal(t, 500, runnerAPIStatus(t, svc.streamLogEventsWithTx(context.Background(), zRunnerTxStarter{tx: &zRunnerTx{rowErr: boom}}, task, logs)))
	require.Equal(t, 500, runnerAPIStatus(t, svc.streamLogEventsWithTx(context.Background(), zRunnerTxStarter{tx: &zRunnerTx{
		row:       db.InsertWorkflowLogNextSequenceRow{ID: 1, WorkflowRunID: 10, WorkflowStepID: 20, Sequence: 1, Stream: "stdout", Entry: "hello", CreatedAt: time.Now()},
		commitErr: boom,
	}}, task, logs)))
	require.Equal(t, 500, runnerAPIStatus(t, (&runnerService{queries: &mockRunnerQuerier{
		notifyWorkflowLogFn: func(context.Context, db.NotifyWorkflowLogParams) error {
			return boom
		},
	}}).streamLogEventsWithTx(context.Background(), zRunnerTxStarter{tx: &zRunnerTx{
		row: db.InsertWorkflowLogNextSequenceRow{ID: 1, WorkflowRunID: 10, WorkflowStepID: 20, Sequence: 1, Stream: "stdout", Entry: "hello", CreatedAt: time.Now()},
	}}, task, logs)))

	attempts := 0
	_, err := insertWorkflowLog(context.Background(), &mockRunnerQuerier{
		insertWorkflowLogNextSequenceFn: func(context.Context, db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			attempts++
			return db.InsertWorkflowLogNextSequenceRow{}, &pgconn.PgError{Code: "23505"}
		},
	}, 1, 2, parsedRunnerLogEvent{stream: "stdout", text: "x"})
	require.Equal(t, workflowLogInsertMaxAttempts, attempts)
	require.Equal(t, 500, runnerAPIStatus(t, err))
	require.False(t, isWorkflowLogSequenceConflict(errors.New("plain")))
	require.False(t, isWorkflowLogSequenceConflict(&pgconn.PgError{Code: "99999"}))
	require.True(t, isWorkflowLogSequenceConflict(&pgconn.PgError{Code: "23505"}))
	require.True(t, isWorkflowLogBudgetExceeded(&pgconn.PgError{Code: "54000", ConstraintName: "workflow_run_log_budget"}))
	require.False(t, isWorkflowLogBudgetExceeded(&pgconn.PgError{Code: "54000", ConstraintName: "other_budget"}))

	_, err = insertWorkflowLog(context.Background(), &mockRunnerQuerier{
		insertWorkflowLogNextSequenceFn: func(context.Context, db.InsertWorkflowLogNextSequenceParams) (db.InsertWorkflowLogNextSequenceRow, error) {
			return db.InsertWorkflowLogNextSequenceRow{}, &pgconn.PgError{Code: "54000", ConstraintName: "workflow_run_log_budget"}
		},
	}, 1, 2, parsedRunnerLogEvent{stream: "stdout", text: "x"})
	require.Equal(t, 413, runnerAPIStatus(t, err))
}

func TestRunner_Z_CompleteTaskBranches(t *testing.T) {
	boom := errors.New("boom")
	scoped := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 20})
	scoped = middleware.ContextWithSharedAgentToken(scoped)

	err := NewRunnerService(&mockRunnerQuerier{}).CompleteTask(scoped, RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "done"})
	require.Equal(t, 403, runnerAPIStatus(t, err), "a run-scoped context never completes a task")

	err = NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 0, boom
		},
	}).CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "done"})
	require.Equal(t, 500, runnerAPIStatus(t, err))

	err = NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 42, nil
		},
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, boom
		},
	}).CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "done"})
	require.NoError(t, err)

	err = NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 42, nil
		},
		listBlockedTasksFn: func(context.Context, int64) ([]db.ListBlockedTasksForRunRow, error) {
			return nil, boom
		},
	}).CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "done"})
	require.Equal(t, 500, runnerAPIStatus(t, err))

	writer := &mockRunnerCommitStatusWriter{
		updateFn: func(context.Context, int64, string, string, string) (db.CommitStatus, error) {
			return db.CommitStatus{}, boom
		},
	}
	checks := &mockRunnerCheckRunService{
		updateFn: func(context.Context, int64, string, string, int64, services.GitHubCheckRunUpdate) (services.GitHubCheckRunResult, error) {
			return services.GitHubCheckRunResult{}, boom
		},
	}
	dispatcher := &mockRunnerWorkflowDispatcher{
		dispatchFn: func(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
			return nil, boom
		},
	}
	err = NewRunnerService(&mockRunnerQuerier{
		markWorkflowTaskDoneFn: func(context.Context, db.MarkWorkflowTaskDoneParams) (int64, error) {
			return 42, nil
		},
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{
				ID:               42,
				RepositoryID:     9,
				Status:           "running",
				TriggerRef:       "refs/heads/main",
				TriggerCommitSha: "abc",
				CheckRunID:       pgtype.Int8{Int64: 77, Valid: true},
			}, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(context.Context, int64) (string, error) {
			return "success", nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 9, Name: "demo", UserID: pgtype.Int8{Int64: 8, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 8, Username: "alice"}, nil
		},
		getWorkflowDefinitionNameByRunIDFn: func(context.Context, int64) (string, error) {
			return "ci", nil
		},
	}, WithRunnerCommitStatusWriter(writer), WithRunnerGitHubCheckRunService(checks), WithRunnerWorkflowDispatcher(dispatcher), WithRunnerGitHubInstallationResolver(&mockRunnerInstallationResolver{
		resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
			return 123, nil
		},
	})).CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "done"})
	require.NoError(t, err)
	require.Len(t, writer.updateCalls, 1)
	require.Len(t, checks.updateCalls, 1)
	require.Len(t, dispatcher.calls, 1)
}

func TestRunner_Z_AgentSessionTransitionBranches(t *testing.T) {
	boom := errors.New("boom")
	var nilSvc *runnerService
	nilSvc.transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")
	(&runnerService{}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")

	(&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, boom
		},
	}}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")

	(&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{Payload: []byte(`{`)}, nil
		},
	}}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")

	(&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{Payload: []byte(`{"kind":"shell","session_id":"s"}`)}, nil
		},
	}}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")

	(&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{Payload: []byte(`{"kind":"agent","session_id":"s"}`)}, nil
		},
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			return db.AgentSession{}, boom
		},
	}}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")

	notified := false
	(&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{Payload: []byte(`{"kind":"agent","session_id":"00000000-0000-0000-0000-000000000001"}`)}, nil
		},
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			return db.AgentSession{ID: argStringWithoutDashes("00000000-0000-0000-0000-000000000001"), Status: "completed"}, nil
		},
		notifyAgentSessionFn: func(context.Context, db.NotifyAgentSessionParams) error {
			notified = true
			return nil
		},
	}}).transitionAgentSessionForTerminalWorkflowRun(context.Background(), 1, "success")
	require.True(t, notified)
}

func argStringWithoutDashes(value string) string {
	return strings.ReplaceAll(value, "-", "")
}

func TestRunner_Z_CheckRunAnnotationHelpers(t *testing.T) {
	_, ok := parseGitHubCommandAnnotation("plain")
	require.False(t, ok)
	_, ok = parseGitHubCommandAnnotation("::error line=2::message")
	require.False(t, ok)
	_, ok = parseGitHubCommandAnnotation("::error file=http://example.com/a.go,line=2::message")
	require.False(t, ok)
	_, ok = parseGitHubCommandAnnotation("::error file=a.go,line=2::   ")
	require.False(t, ok)

	ann, ok := parseGitHubCommandAnnotation("::warning file=/workspace/a.go,line=4,endline=3::careful")
	require.True(t, ok)
	require.Equal(t, "a.go", ann.Path)
	require.Equal(t, 4, ann.EndLine)

	_, ok = parsePathLineAnnotation("plain")
	require.False(t, ok)
	_, ok = parsePathLineAnnotation("http://x:1: bad")
	require.False(t, ok)
	_, ok = parsePathLineAnnotation("a.go:0: bad")
	require.False(t, ok)
	_, ok = parsePathLineAnnotation("a.go:2:   ")
	require.False(t, ok)
	ann, ok = parsePathLineAnnotation(`"a\b.go":2:1: failed lint`)
	require.True(t, ok)
	require.Equal(t, "a/b.go", ann.Path)
	require.Equal(t, 2, ann.EndLine)

	params := parseGitHubCommandAnnotationParams(`, bad, =empty, file=a%2Cb.go, line=abc`)
	require.Equal(t, "a,b.go", params["file"])
	require.Equal(t, 1, parsePositiveInt("bad", 1))
	require.Equal(t, "", normalizeCheckRunAnnotationPath("https://example.com/file.go"))
	require.Equal(t, "failure", normalizeCheckRunAnnotationLevel("failure"))
	require.Equal(t, "warning", normalizeCheckRunAnnotationLevel("warn"))
	require.Equal(t, "notice", normalizeCheckRunAnnotationLevel("information"))
	require.Equal(t, "", normalizeCheckRunAnnotationLevel("debug"))
	require.Equal(t, "failure", taskStatusToResult("failed"))

	level, msg := splitAnnotationLevelAndMessage("")
	require.Empty(t, level)
	require.Empty(t, msg)
	level, msg = splitAnnotationLevelAndMessage("error: broke")
	require.Equal(t, "failure", level)
	require.Equal(t, "broke", msg)
	level, _ = splitAnnotationLevelAndMessage("notice: look")
	require.Equal(t, "notice", level)
	level, _ = splitAnnotationLevelAndMessage("warn me")
	require.Equal(t, "warning", level)
	level, _ = splitAnnotationLevelAndMessage("plain")
	require.Equal(t, "notice", level)
	require.Empty(t, parseIfExprFromPayload([]byte(`{`)))
	require.Empty(t, parseNeedsFromPayload([]byte(`{`)))
	require.Empty(t, parseTriggerEventFromPayload([]byte(`{`)).Type)
	require.Equal(t, "Workflow failed", services.WorkflowRunStatusDescription("failure"))
	require.Equal(t, "running", taskStatusToResult("running"))

	_, ok = parsePathLineAnnotation("/:1: message")
	require.False(t, ok)
}

func TestRunner_Z_CheckRunServiceBranches(t *testing.T) {
	boom := errors.New("boom")
	run := db.WorkflowRun{ID: 1, RepositoryID: 9, CheckRunID: pgtype.Int8{Int64: 77, Valid: true}}
	require.NoError(t, (&runnerService{}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), db.WorkflowRun{}, "success"))
	require.NoError(t, (&runnerService{queries: zRunnerQuerierOnly{&mockRunnerQuerier{}}, checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{}, checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	zResolver := func(id int64) *mockRunnerInstallationResolver {
		return &mockRunnerInstallationResolver{resolveFn: func(context.Context, int64, int64, string, string) (int64, error) {
			return id, nil
		}}
	}
	require.NoError(t, (&runnerService{queries: zRunnerResolverOnly{
		RunnerQuerier: &mockRunnerQuerier{},
		repoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, nil
		},
		userFn: func(context.Context, int64) (db.User, error) { return db.User{}, nil },
		orgFn:  func(context.Context, int64) (db.Organization, error) { return db.Organization{}, nil },
	}, installationResolver: zResolver(1), checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, boom
		},
	}, installationResolver: zResolver(1), checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 9, Name: ""}, nil
		},
	}, installationResolver: zResolver(1), checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 9, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 1, Username: "alice"}, nil
		},
	}, installationResolver: zResolver(0), checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 9, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 1, Username: "alice"}, nil
		},
		listWorkflowLogsSinceFn: func(context.Context, db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			return nil, boom
		},
	}, installationResolver: zResolver(1), checkRunService: &mockRunnerCheckRunService{}}).updateGitHubCheckRunForCompletion(context.Background(), run, "success"))

	q := &mockRunnerQuerier{
		listWorkflowLogsSinceFn: func(context.Context, db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
			logs := make([]db.WorkflowLog, 0, checkRunAnnotationLogPageSize)
			for i := int32(0); i < checkRunAnnotationLogPageSize; i++ {
				logs = append(logs, db.WorkflowLog{ID: int64(i + 1), Entry: "::error file=a.go,line=1::message " + string(rune(i))})
			}
			return logs, nil
		},
	}
	annotations, err := (&runnerService{queries: q}).collectCheckRunAnnotationsFromLogs(context.Background(), 1)
	require.NoError(t, err)
	require.Len(t, annotations, maxCheckRunAnnotationsFromLogs)

	require.Empty(t, resolveRepositoryOwnerForChecks(context.Background(), db.Repository{UserID: pgtype.Int8{Int64: 8, Valid: true}}, &mockRunnerQuerier{}))
	require.Equal(t, "acme", resolveRepositoryOwnerForChecks(context.Background(), db.Repository{OrgID: pgtype.Int8{Int64: 9, Valid: true}}, &mockRunnerQuerier{
		getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
			return db.Organization{Name: " acme "}, nil
		},
	}))
	require.Empty(t, resolveRepositoryOwnerForChecks(context.Background(), db.Repository{OrgID: pgtype.Int8{Int64: 9, Valid: true}}, &mockRunnerQuerier{}))
	require.Empty(t, resolveRepositoryOwnerForChecks(context.Background(), db.Repository{}, &mockRunnerQuerier{}))
}

func TestRunner_Z_DependencyProgressBranches(t *testing.T) {
	boom := errors.New("boom")
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: func(context.Context, int64) ([]db.ListBlockedTasksForRunRow, error) {
			return nil, boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: func(context.Context, int64) ([]db.ListBlockedTasksForRunRow, error) {
			return []db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{}`)}}, nil
		},
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return nil, boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{}`)}}),
		unblockTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"]}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "running"}}, nil
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"],"if":"always()"}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "failed"}}, nil
		},
		unblockTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"],"if":"needs.build.result == \"success\""}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "failed"}}, nil
		},
		skipBlockedTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"]}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "failed"}}, nil
		},
		skipBlockedTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"]}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "done"}}, nil
		},
		unblockTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))

	// A deferred if-expression that cannot be evaluated must fail closed:
	// the task is skipped, never unblocked (the gate must not open on error).
	skipped := false
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"],"if":"needs.build.result == \"success\" && custom.thing == \"x\""}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "done"}}, nil
		},
		unblockTaskFn: func(context.Context, int64) error {
			return errors.New("must not unblock a task whose if expression failed to evaluate")
		},
		skipBlockedTaskFn: func(context.Context, int64) error {
			skipped = true
			return nil
		},
	}}).progressDependencies(context.Background(), 1))
	require.True(t, skipped)
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: zBlockedOnce([]db.ListBlockedTasksForRunRow{{ID: 1, Payload: []byte(`{"needs":["build"],"if":"custom.gate == \"open\""}`)}}),
		listTaskStepInfoFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return []db.ListTaskStepInfoForRunRow{{StepName: "build", Status: "done"}}, nil
		},
		skipBlockedTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).progressDependencies(context.Background(), 1))

	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		skipBlockedTaskFn: func(context.Context, int64) error {
			return boom
		},
	}}).skipTaskAndStep(context.Background(), 1))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowTaskStepIDFn: func(context.Context, int64) (int64, error) {
			return 0, boom
		},
	}}).skipTaskAndStep(context.Background(), 1))
}

func zBlockedOnce(rows []db.ListBlockedTasksForRunRow) func(context.Context, int64) ([]db.ListBlockedTasksForRunRow, error) {
	calls := 0
	return func(context.Context, int64) ([]db.ListBlockedTasksForRunRow, error) {
		calls++
		if calls == 1 {
			return rows, nil
		}
		return nil, nil
	}
}

func TestRunner_Z_DispatchBranches(t *testing.T) {
	boom := errors.New("boom")
	svc := &runnerService{queries: &mockRunnerQuerier{}}
	require.NoError(t, svc.dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{}, "success"))
	// Recursion guard: a workflow_run-triggered run must not re-dispatch
	// workflow_run events (self/mutually-referential triggers would chain forever).
	guardDispatcher := &mockRunnerWorkflowDispatcher{}
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowDefinitionNameByRunIDFn: func(context.Context, int64) (string, error) {
			return "ci", nil
		},
	}, workflowDispatcher: guardDispatcher}).dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{ID: 1, TriggerEvent: "workflow_run", TriggerCommitSha: "abc"}, "success"))
	require.Empty(t, guardDispatcher.calls, "workflow_run-triggered runs must not emit chained workflow_run dispatches")
	require.NoError(t, (&runnerService{workflowDispatcher: &mockRunnerWorkflowDispatcher{}}).dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{TriggerCommitSha: "abc"}, "unknown"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{}, workflowDispatcher: &mockRunnerWorkflowDispatcher{}}).dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{ID: 1, TriggerCommitSha: "abc"}, "success"))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowDefinitionNameByRunIDFn: func(context.Context, int64) (string, error) {
			return "", boom
		},
	}, workflowDispatcher: &mockRunnerWorkflowDispatcher{}}).dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{ID: 1, TriggerCommitSha: "abc"}, "success"))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowDefinitionNameByRunIDFn: func(context.Context, int64) (string, error) {
			return "ci", nil
		},
	}, workflowDispatcher: &mockRunnerWorkflowDispatcher{dispatchFn: func(context.Context, services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
		return nil, boom
	}}}).dispatchTriggeredWorkflowRuns(context.Background(), db.WorkflowRun{ID: 1, TriggerCommitSha: "abc"}, "success"))

	require.NoError(t, svc.dispatchWorkflowRunEvent(context.Background(), 1, "success"))
	require.NoError(t, (&runnerService{dispatcher: &mockRunnerDispatcher{}}).dispatchWorkflowRunEvent(context.Background(), 1, "unknown"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{}, dispatcher: &mockRunnerDispatcher{}}).dispatchWorkflowRunEvent(context.Background(), 1, "success"))
	require.NoError(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}, dispatcher: &mockRunnerDispatcher{}}).dispatchWorkflowRunEvent(context.Background(), 1, "success"))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, boom
		},
	}, dispatcher: &mockRunnerDispatcher{}}).dispatchWorkflowRunEvent(context.Background(), 1, "success"))
	require.Error(t, (&runnerService{queries: &mockRunnerQuerier{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 1, RepositoryID: 2}, nil
		},
	}, dispatcher: &mockRunnerDispatcher{dispatchErr: boom}}).dispatchWorkflowRunEvent(context.Background(), 1, "success"))
}

func TestRunner_Z_CollectAnnotationsDeduplicates(t *testing.T) {
	entry, _ := json.Marshal(map[string]string{"ignored": "x"})
	require.NotEmpty(t, entry)
	annotations := parseCheckRunAnnotationsFromLogEntry("a.go:1: warning: first\na.go:1: warning: first")
	require.Len(t, annotations, 2)
	key := checkRunAnnotationKey(annotations[0])
	require.Equal(t, key, checkRunAnnotationKey(annotations[1]))
}
