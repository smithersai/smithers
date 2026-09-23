package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

func TestAgentFlowTerminalTransitionRequiresCurrentRunAndTask(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "Flow projection", Status: "active",
	})
	require.NoError(t, err)
	definition, err := q.UpsertAgentWorkflowDefinition(ctx, repoID)
	require.NoError(t, err)
	makeRunAndTask := func() (int64, int64) {
		run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
			RepositoryID: repoID, WorkflowDefinitionID: definition.ID, Status: "queued",
			TriggerEvent: "agent", TriggerRef: "main", TriggerCommitSha: "test",
			DispatchInputs: json.RawMessage(`{}`),
		})
		require.NoError(t, err)
		step, err := q.CreateWorkflowStep(ctx, CreateWorkflowStepParams{
			WorkflowRunID: run.ID, Name: "agent", Position: 1, Status: "queued",
		})
		require.NoError(t, err)
		task, err := q.CreateWorkflowTask(ctx, CreateWorkflowTaskParams{
			WorkflowRunID: run.ID, WorkflowStepID: step.ID, RepositoryID: repoID,
			Status: "pending", Priority: 1, Payload: json.RawMessage(`{}`), AvailableAt: time.Now(),
		})
		require.NoError(t, err)
		return run.ID, task.ID
	}
	oldRun, oldTask := makeRunAndTask()
	newRun, newTask := makeRunAndTask()
	_, err = q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{
		ID: sessionID, WorkflowRunID: pgtype.Int8{Int64: newRun, Valid: true},
	})
	require.NoError(t, err)

	_, err = q.GetAgentSessionForFlowProjection(ctx, GetAgentSessionForFlowProjectionParams{
		SessionID: sessionID, WorkflowRunID: oldRun, WorkflowTaskID: oldTask,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetAgentSessionForFlowProjection(ctx, GetAgentSessionForFlowProjectionParams{
		SessionID: sessionID, WorkflowRunID: newRun, WorkflowTaskID: oldTask,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	transition := func(runID, taskID int64) error {
		_, err := q.UpdateAgentSessionTerminalStatusForFlow(ctx, UpdateAgentSessionTerminalStatusForFlowParams{
			SessionID: sessionID, WorkflowRunID: pgtype.Int8{Int64: runID, Valid: true},
			WorkflowTaskID: taskID, Status: "completed",
			FinishedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
		})
		return err
	}
	require.ErrorIs(t, transition(oldRun, oldTask), pgx.ErrNoRows)
	require.ErrorIs(t, transition(newRun, oldTask), pgx.ErrNoRows)
	current, err := q.GetAgentSession(ctx, sessionID)
	require.NoError(t, err)
	require.Equal(t, "active", current.Status)
	require.Equal(t, newRun, current.WorkflowRunID.Int64)
	require.False(t, current.FinishedAt.Valid)

	require.NoError(t, transition(newRun, newTask))
	require.ErrorIs(t, transition(newRun, newTask), pgx.ErrNoRows)
	current, err = q.GetAgentSession(ctx, sessionID)
	require.NoError(t, err)
	require.Equal(t, "completed", current.Status)
	require.True(t, current.FinishedAt.Valid)
}
