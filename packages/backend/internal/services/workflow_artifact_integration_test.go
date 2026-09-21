package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowArtifactServiceIntegration_ConfirmedArtifactNameIsImmutable(t *testing.T) {
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)

	ctx := context.Background()

	researchDef, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Research",
		Path:         ".smithers/workflows/research.tsx",
		Config: json.RawMessage(`{
			"on":{"workflow_dispatch":{}},
			"jobs":{
				"research":{"runs-on":"ubuntu","steps":[{"run":"echo research"}]}
			}
		}`),
	})
	require.NoError(t, err)

	planDef, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Plan",
		Path:         ".smithers/workflows/plan.tsx",
		Config: json.RawMessage(`{
			"on":{"workflow_artifact":{"workflows":["Research"],"names":["research-*"]}},
			"jobs":{
				"plan":{"runs-on":"ubuntu","steps":[{"run":"echo plan"}]}
			}
		}`),
	})
	require.NoError(t, err)

	workflowRuns := NewWorkflowRunService(queries)
	artifactService := NewWorkflowArtifactService(
		queries,
		blob.NewMemoryStore(),
		time.Minute,
		WithWorkflowArtifactWorkflowRunService(workflowRuns),
	)

	sourceResults, err := workflowRuns.DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID:         repoID,
		WorkflowDefinitionID: &researchDef.ID,
		Event: TriggerEvent{
			Type:      "workflow_dispatch",
			Ref:       "refs/heads/main",
			CommitSHA: "abc123abc123abc123abc123abc123abc123abcd",
		},
	})
	require.NoError(t, err)
	require.Len(t, sourceResults, 1)

	researchRun, err := queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           sourceResults[0].WorkflowRunID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)

	_, err = artifactService.IssueUploadURL(ctx, researchRun, WorkflowArtifactUploadInput{
		Name:        "research-summary.md",
		Size:        64,
		ContentType: "text/markdown",
	})
	require.NoError(t, err)
	_, err = artifactService.ConfirmUpload(ctx, researchRun, "research-summary.md", "")
	require.NoError(t, err)

	planRuns, err := queries.ListWorkflowRunsByDefinition(ctx, db.ListWorkflowRunsByDefinitionParams{
		WorkflowDefinitionID: planDef.ID,
		RepositoryID:         repoID,
		PageOffset:           0,
		PageSize:             10,
	})
	require.NoError(t, err)
	require.Len(t, planRuns, 1)

	firstPlanRunID := planRuns[0].ID
	assert.Equal(t, "workflow_artifact", planRuns[0].TriggerEvent)
	assert.Equal(t, researchRun.TriggerRef, planRuns[0].TriggerRef)
	assert.Equal(t, researchRun.TriggerCommitSha, planRuns[0].TriggerCommitSha)

	steps, err := queries.ListWorkflowStepsByRunID(ctx, firstPlanRunID)
	require.NoError(t, err)
	require.Len(t, steps, 1)
	assert.Equal(t, "plan", steps[0].Name)

	var taskEvent, taskRef string
	err = pool.QueryRow(
		ctx,
		`SELECT payload->>'event', payload->>'ref'
		 FROM workflow_tasks
		 WHERE workflow_run_id = $1
		 ORDER BY id ASC
		 LIMIT 1`,
		firstPlanRunID,
	).Scan(&taskEvent, &taskRef)
	require.NoError(t, err)
	assert.Equal(t, "workflow_artifact", taskEvent)
	assert.Equal(t, researchRun.TriggerRef, taskRef)

	_, err = artifactService.IssueUploadURL(ctx, researchRun, WorkflowArtifactUploadInput{
		Name:        "research-summary.md",
		Size:        96,
		ContentType: "text/markdown",
	})
	require.Error(t, err)
	assert.Equal(t, 409, httpStatus(err))

	planRuns, err = queries.ListWorkflowRunsByDefinition(ctx, db.ListWorkflowRunsByDefinitionParams{
		WorkflowDefinitionID: planDef.ID,
		RepositoryID:         repoID,
		PageOffset:           0,
		PageSize:             10,
	})
	require.NoError(t, err)
	require.Len(t, planRuns, 1)
	assert.Equal(t, firstPlanRunID, planRuns[0].ID, "a rejected overwrite must not dispatch another downstream run")
}
