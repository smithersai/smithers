package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowSchedulesSQLHDB = chunk5SQLHDB
type workflowSchedulesSQLHRows = chunk5SQLHRows

func TestWorkflowSchedulesSQL_H_UpsertClaimUpdateAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	def, err := q.CreateWorkflowDefinition(ctx, CreateWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "schedule-h", Path: ".smithers/workflows/schedule-" + randSlug(t) + ".yml", Config: json.RawMessage(`{"triggers":[{"type":"schedule"}]}`),
	})
	require.NoError(t, err)
	cron := "*/5 * * * *"
	require.NoError(t, q.UpsertWorkflowScheduleSpec(ctx, UpsertWorkflowScheduleSpecParams{
		WorkflowDefinitionID: def.ID, RepositoryID: repoID, CronExpression: cron, NextFireAt: time.Now().Add(-time.Minute),
	}))
	claimed, err := q.ClaimDueWorkflowScheduleSpecs(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, def.ID, claimed[0].WorkflowDefinitionID)
	claimedAgain, err := q.ClaimDueWorkflowScheduleSpecs(ctx, 10)
	require.NoError(t, err)
	assert.Empty(t, claimedAgain)

	nextFire := time.Now().Add(time.Hour)
	require.NoError(t, q.UpdateWorkflowScheduleFireTimes(ctx, UpdateWorkflowScheduleFireTimesParams{
		ID: claimed[0].ID, PrevFireAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}, NextFireAt: nextFire,
	}))
	require.NoError(t, q.UpsertWorkflowScheduleSpec(ctx, UpsertWorkflowScheduleSpecParams{
		WorkflowDefinitionID: def.ID, RepositoryID: repoID, CronExpression: cron, NextFireAt: nextFire.Add(time.Hour),
	}))
	require.NoError(t, q.DeleteWorkflowScheduleSpecsByDefinition(ctx, def.ID))
	claimed, err = q.ClaimDueWorkflowScheduleSpecs(ctx, 10)
	require.NoError(t, err)
	assert.Empty(t, claimed)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		return spQ.UpsertWorkflowScheduleSpec(ctx, UpsertWorkflowScheduleSpecParams{WorkflowDefinitionID: 999999999, RepositoryID: repoID, CronExpression: "* * * * *", NextFireAt: time.Now()})
	})
}

func TestWorkflowSchedulesSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("workflow schedules h failed")
	callClaim := func(q *Queries) error { _, err := q.ClaimDueWorkflowScheduleSpecs(context.Background(), 1); return err }
	require.ErrorIs(t, callClaim(New(workflowSchedulesSQLHDB{queryErr: sentinel})), sentinel)
	require.ErrorIs(t, callClaim(New(workflowSchedulesSQLHDB{rows: &workflowSchedulesSQLHRows{next: true, scanErr: sentinel}})), sentinel)
	require.ErrorIs(t, callClaim(New(workflowSchedulesSQLHDB{rows: &workflowSchedulesSQLHRows{err: sentinel}})), sentinel)

	execQ := New(workflowSchedulesSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteWorkflowScheduleSpecsByDefinition(context.Background(), 1), sentinel)
	require.ErrorIs(t, execQ.UpdateWorkflowScheduleFireTimes(context.Background(), UpdateWorkflowScheduleFireTimesParams{}), sentinel)
	require.ErrorIs(t, execQ.UpsertWorkflowScheduleSpec(context.Background(), UpsertWorkflowScheduleSpecParams{}), sentinel)
}
