package clusterservices

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Cloud CI runs 11702 and 11706 finished with workflow_tasks.status='failed'
// while every workflow_steps row stayed at status='running' with a NULL
// completed_at, so the run detail API and the UI showed each node as still
// running on a failed run. CompleteTask must mirror the settled task status
// onto its step.
func TestRunnerService_CompleteTask_FinalizesWorkflowStep(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		taskStatus string
		stepStatus string
	}{
		{name: "done maps to success", taskStatus: "done", stepStatus: "success"},
		{name: "failed maps to failure", taskStatus: "failed", stepStatus: "failure"},
		{name: "cancelled maps to cancelled", taskStatus: "cancelled", stepStatus: "cancelled"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var stepIDLookups []int64
			var terminal []db.UpdateWorkflowStepStatusTerminalParams

			svc := NewRunnerService(&mockRunnerQuerier{
				markWorkflowTaskDoneFn: func(_ context.Context, arg db.MarkWorkflowTaskDoneParams) (int64, error) {
					assert.Equal(t, int64(91), arg.ID)
					assert.Equal(t, tc.taskStatus, arg.Status)
					return 11702, nil
				},
				getWorkflowTaskStepIDFn: func(_ context.Context, taskID int64) (int64, error) {
					stepIDLookups = append(stepIDLookups, taskID)
					return 4242, nil
				},
				updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
					terminal = append(terminal, arg)
					return 1, nil
				},
				updateWorkflowRunStatusBasedOnTasksFn: func(_ context.Context, workflowRunID int64) (string, error) {
					assert.Equal(t, int64(11702), workflowRunID)
					return "failure", nil
				},
				getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
					return db.WorkflowRun{ID: runID, RepositoryID: 55, Status: "running"}, nil
				},
			})

			err := svc.CompleteTask(context.Background(), RunnerCompleteTaskInput{
				TaskID:   91,
				RunnerID: 17,
				Status:   tc.taskStatus,
			})
			require.NoError(t, err)

			assert.Equal(t, []int64{91}, stepIDLookups)
			require.Len(t, terminal, 1)
			assert.Equal(t, int64(4242), terminal[0].StepID)
			assert.Equal(t, tc.stepStatus, terminal[0].Status)
		})
	}
}

// A step whose task was never settled must not be terminalized. Terminate
// requeues the runner's assigned/running tasks (RequeueTasksForRunner also
// resets their steps back to 'queued'), so it must leave no terminal step
// behind when a runner restarts mid-task.
func TestRunnerService_Terminate_RequeueDoesNotFinalizeWorkflowStep(t *testing.T) {
	t.Parallel()

	requeued := 0
	var terminal []db.UpdateWorkflowStepStatusTerminalParams

	svc := NewRunnerService(&mockRunnerQuerier{
		requeueTasksForRunnerFn: func(_ context.Context, runnerID pgtype.Int8) (int64, error) {
			requeued++
			assert.Equal(t, pgtype.Int8{Int64: 17, Valid: true}, runnerID)
			return 1, nil
		},
		terminateRunnerFn: func(_ context.Context, id int64) (clusterdb.RunnerPool, error) {
			assert.Equal(t, int64(17), id)
			return clusterdb.RunnerPool{ID: id, Status: "terminated"}, nil
		},
		getWorkflowTaskStepIDFn: func(_ context.Context, taskID int64) (int64, error) {
			t.Fatalf("requeue must not look up a step id (task %d)", taskID)
			return 0, nil
		},
		updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
			terminal = append(terminal, arg)
			return 1, nil
		},
	})

	require.NoError(t, svc.Terminate(context.Background(), 17))
	assert.Equal(t, 1, requeued)
	assert.Empty(t, terminal)
}
