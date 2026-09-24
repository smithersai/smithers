package clusterservices

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type runnerCovMetrics struct {
	status  string
	seconds float64
}

func (m *runnerCovMetrics) ObserveWorkflowRunCompletion(status string, seconds float64) {
	m.status = status
	m.seconds = seconds
}

func TestRunner_Cov_CheckRunAnnotationsAndUpdate(t *testing.T) {
	t.Parallel()

	checks := &mockRunnerCheckRunService{}
	svc := &runnerService{
		checkRunService: checks,
		installationResolver: &mockRunnerInstallationResolver{
			resolveFn: func(_ context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error) {
				assert.Equal(t, int64(9), ownerUserID)
				assert.Equal(t, int64(0), ownerOrgID)
				assert.Equal(t, "Alice", owner)
				assert.Equal(t, "DemoRepo", repo)
				return 123, nil
			},
		},
		queries: &mockRunnerQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				assert.Equal(t, int64(44), id)
				return db.Repository{
					ID:     id,
					Name:   "DemoRepo",
					UserID: pgtype.Int8{Int64: 9, Valid: true},
				}, nil
			},
			getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
				assert.Equal(t, int64(9), id)
				return db.User{ID: id, Username: "Alice"}, nil
			},
			listWorkflowLogsSinceFn: func(_ context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error) {
				assert.Equal(t, int64(88), arg.RunID)
				assert.Equal(t, int32(checkRunAnnotationLogPageSize), arg.PageSize)
				return []db.WorkflowLog{
					{
						ID: 1,
						Entry: "::error file=/workspace/src/app.go,line=7,endLine=5::bad%2C value\n" +
							"/workspace/pkg/test.go:10:12: warning: be careful",
					},
					{
						ID: 2,
						Entry: "::error file=/workspace/src/app.go,line=7,endLine=5::bad%2C value\n" +
							"https://example.test/file.go:1: nope",
					},
				}, nil
			},
		},
	}

	run := db.WorkflowRun{
		ID:           88,
		RepositoryID: 44,
		CheckRunID:   pgtype.Int8{Int64: 777, Valid: true},
	}
	err := svc.updateGitHubCheckRunForCompletion(context.Background(), run, "failure")
	require.NoError(t, err)
	require.Len(t, checks.updateCalls, 1)

	call := checks.updateCalls[0]
	assert.Equal(t, int64(123), call.installationID)
	assert.Equal(t, "Alice", call.owner)
	assert.Equal(t, "DemoRepo", call.repo)
	assert.Equal(t, int64(777), call.checkRunID)
	assert.Equal(t, "completed", call.update.Status)
	assert.Equal(t, "failure", call.update.Conclusion)
	require.NotNil(t, call.update.Output)
	require.Len(t, call.update.Output.Annotations, 2)
	assert.Equal(t, services.GitHubCheckRunAnnotation{
		Path:            "src/app.go",
		StartLine:       7,
		EndLine:         7,
		AnnotationLevel: "failure",
		Message:         "bad, value",
	}, call.update.Output.Annotations[0])
	assert.Equal(t, "pkg/test.go", call.update.Output.Annotations[1].Path)
	assert.Equal(t, "warning", call.update.Output.Annotations[1].AnnotationLevel)
	assert.Contains(t, call.update.Output.Summary, "Detected 2 inline annotation")
}

func TestRunner_Cov_OptionsRuntimeAndCompletionErrors(t *testing.T) {
	t.Parallel()

	metrics := &runnerCovMetrics{}
	svcIface := NewRunnerService(&mockRunnerQuerier{}, WithRunnerMetrics(metrics))
	svc := svcIface.(*runnerService)
	assert.Same(t, metrics, svc.metrics)

	_, err := svc.GetTaskRuntimeEnvironment(context.Background(), 1)
	assert.Equal(t, 401, runnerAPIStatus(t, err))

	badSecretSvc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			assert.Equal(t, int64(12), arg.WorkflowRunID)
			return db.GetWorkflowTaskRuntimeContextRow{ID: arg.TaskID, WorkflowRunID: arg.WorkflowRunID, RepositoryID: 101}, nil
		},
	}, WithRunnerSecretInjector(services.NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "bad-name", Value: "x"}}, nil
		},
	}, webhook.NoopSecretCodec{}))).(*runnerService)
	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12})
	_, err = badSecretSvc.GetTaskRuntimeEnvironment(ctx, 55)
	assert.Equal(t, 500, runnerAPIStatus(t, err))

	err = svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{TaskID: 1, RunnerID: 1, Status: "bogus"})
	assert.Equal(t, 422, runnerAPIStatus(t, err))

	scopedSvc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			assert.Equal(t, int64(90), taskID)
			return db.GetWorkflowTaskForRunnerRow{ID: taskID, WorkflowRunID: 99}, nil
		},
	})
	scopedCtx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12})
	err = scopedSvc.CompleteTask(scopedCtx, RunnerCompleteTaskInput{TaskID: 90, RunnerID: 3, Status: "done"})
	assert.Equal(t, 403, runnerAPIStatus(t, err))
}

func TestRunner_Cov_ProgressDependenciesIfExpressions(t *testing.T) {
	t.Parallel()

	var unblocked []int64
	var skipped []int64
	var terminal []db.UpdateWorkflowStepStatusTerminalParams
	listCalls := 0
	svc := &runnerService{queries: &mockRunnerQuerier{
		listBlockedTasksFn: func(_ context.Context, workflowRunID int64) ([]db.ListBlockedTasksForRunRow, error) {
			assert.Equal(t, int64(600), workflowRunID)
			listCalls++
			if listCalls > 1 {
				return nil, nil
			}
			return []db.ListBlockedTasksForRunRow{
				{ID: 10, Payload: json.RawMessage(`{}`), StepName: "no-needs"},
				{ID: 11, Payload: json.RawMessage(`{"needs":["build"],"if":"always()"}`), StepName: "cleanup"},
				{ID: 12, Payload: json.RawMessage(`{"needs":["build"],"if":"needs.build.result == \"success\""}`), StepName: "deploy"},
				{ID: 13, Payload: json.RawMessage(`{"needs":["lint"]}`), StepName: "package"},
			}, nil
		},
		listTaskStepInfoFn: func(_ context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error) {
			assert.Equal(t, int64(600), workflowRunID)
			return []db.ListTaskStepInfoForRunRow{
				{ID: 1, StepName: "build", Status: "failed"},
				{ID: 2, StepName: "lint", Status: "done"},
			}, nil
		},
		unblockTaskFn: func(_ context.Context, id int64) error {
			unblocked = append(unblocked, id)
			return nil
		},
		skipBlockedTaskFn: func(_ context.Context, id int64) error {
			skipped = append(skipped, id)
			return nil
		},
		getWorkflowTaskStepIDFn: func(_ context.Context, id int64) (int64, error) {
			return id + 1000, nil
		},
		updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
			terminal = append(terminal, arg)
			return 1, nil
		},
	}}

	require.NoError(t, svc.progressDependencies(context.Background(), 600))
	assert.Equal(t, []int64{10, 11, 13}, unblocked)
	assert.Equal(t, []int64{12}, skipped)
	require.Len(t, terminal, 1)
	assert.Equal(t, int64(1012), terminal[0].StepID)
	assert.Equal(t, "skipped", terminal[0].Status)
}

func TestRunner_Cov_StatusMappingsAndMetricObservation(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "completed", agentSessionStatusForWorkflowRunStatus("success"))
	assert.Equal(t, "cancelled", agentSessionStatusForWorkflowRunStatus("cancelled"))
	assert.Equal(t, "failed", agentSessionStatusForWorkflowRunStatus("error"))
	assert.Equal(t, "Workflow hit an infrastructure error", services.WorkflowRunStatusDescription("error"))
	assert.Equal(t, "Workflow status: waiting", services.WorkflowRunStatusDescription("waiting"))
	assert.Equal(t, "neutral", workflowRunStatusToCheckRunConclusion("cancelled"))
	assert.Equal(t, "neutral", workflowRunStatusToCheckRunConclusion("unknown"))
	assert.Equal(t, "success", taskStatusToResult("done"))
	assert.Equal(t, "failure", taskStatusToResult("failed"))

	metrics := &runnerCovMetrics{}
	services.ObserveWorkflowRunCompletion(metrics, db.WorkflowRun{
		ID:        700,
		Status:    "running",
		CreatedAt: time.Now().Add(-2 * time.Second),
	}, "success")
	assert.Equal(t, "success", metrics.status)
	assert.Greater(t, metrics.seconds, 0.0)

	services.ObserveWorkflowRunCompletion(metrics, db.WorkflowRun{ID: 701, Status: "success", CreatedAt: time.Now()}, "failure")
	assert.Equal(t, "success", metrics.status, "already-terminal runs must not be observed again")

	assert.False(t, isWorkflowLogSequenceConflict(errors.New("plain error")))
}
