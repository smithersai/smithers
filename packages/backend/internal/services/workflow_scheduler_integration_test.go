package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestCronSchedulerWorker_Integration_FiresScheduledRun(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)
	ctx := context.Background()

	// 1. Create a workflow definition
	def, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "DailyCron",
		Path:         ".smithers/workflows/daily.tsx",
		Config: json.RawMessage(`{
			"on":{"schedule":[{"cron":"0 0 * * *"}]},
			"jobs":{
				"test":{"runs-on":"ubuntu","steps":[{"run":"echo hello"}]}
			}
		}`),
	})
	require.NoError(t, err)

	// 2. Create a schedule spec due right now
	err = queries.UpsertWorkflowScheduleSpec(ctx, db.UpsertWorkflowScheduleSpecParams{
		WorkflowDefinitionID: def.ID,
		RepositoryID:         repoID,
		CronExpression:       "0 0 * * *",
		NextFireAt:           time.Now().Add(-1 * time.Minute), // due in the past
	})
	require.NoError(t, err)

	// 3. Run PollOnce
	dispatcher := NewWorkflowRunService(queries)
	worker := NewCronSchedulerWorker(queries, dispatcher)
	err = worker.PollOnce(ctx)
	require.NoError(t, err)

	// 4. Verify run was created
	runs, err := queries.ListWorkflowRunsByRepo(ctx, db.ListWorkflowRunsByRepoParams{
		RepositoryID: repoID,
		PageSize:     10,
		PageOffset:   0,
	})
	require.NoError(t, err)
	require.Len(t, runs, 1)
	assert.Equal(t, def.ID, runs[0].WorkflowDefinitionID)
	assert.Equal(t, "schedule", runs[0].TriggerEvent)
	assert.Equal(t, "queued", runs[0].Status)

	// 5. Verify next_fire_at was updated to the future
	specs, err := pool.Query(ctx, "SELECT id, next_fire_at FROM workflow_schedule_specs WHERE workflow_definition_id = $1", def.ID)
	require.NoError(t, err)
	defer specs.Close()

	require.True(t, specs.Next())
	var specID int64
	var nextFireAt time.Time
	err = specs.Scan(&specID, &nextFireAt)
	require.NoError(t, err)

	assert.True(t, nextFireAt.After(time.Now()))
}
