package deploymentdb

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The supersede predicate is the load-bearing half of the fix: the service
// only cancels what this query returns. It is exercised against a real
// database so the in-memory mirror in internal/services cannot drift from it.
func TestListSupersededWorkflowRuns_ScopesToRepoDefinitionRefAndPushEvent(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "supersede-user")
	repoID := mustCreateRepo(t, pool, userID, "supersede-repo")
	otherRepoID := mustCreateRepo(t, pool, userID, "supersede-other-repo")

	cfg := []byte(`{"on":{"push":{}},"jobs":{}}`)
	ci, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "ci",
		Path:         ".smithers/workflows/ci.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)
	deploy, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "deploy",
		Path:         ".smithers/workflows/deploy.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)
	otherRepoCI, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: otherRepoID,
		Name:         "ci",
		Path:         ".smithers/workflows/ci.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	mkRun := func(defID int64, repo int64, ref, event, status string) WorkflowRun {
		t.Helper()
		run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
			RepositoryID:         repo,
			WorkflowDefinitionID: defID,
			Status:               status,
			TriggerEvent:         event,
			TriggerRef:           ref,
			TriggerCommitSha:     "sha-" + ref + "-" + status,
		})
		require.NoError(t, err)
		return run
	}

	queuedSameRef := mkRun(ci.ID, repoID, "refs/heads/main", "push", "queued")
	runningSameRef := mkRun(ci.ID, repoID, "refs/heads/main", "push", "running")
	succeeded := mkRun(ci.ID, repoID, "refs/heads/main", "push", "success")
	otherRef := mkRun(ci.ID, repoID, "refs/heads/release", "push", "queued")
	manualDispatch := mkRun(ci.ID, repoID, "refs/heads/main", "manual_dispatch", "queued")
	otherWorkflow := mkRun(deploy.ID, repoID, "refs/heads/main", "push", "queued")
	otherRepo := mkRun(otherRepoCI.ID, otherRepoID, "refs/heads/main", "push", "queued")
	newest := mkRun(ci.ID, repoID, "refs/heads/main", "push", "queued")
	newerStill := mkRun(ci.ID, repoID, "refs/heads/main", "push", "queued")

	ids, err := q.ListSupersededWorkflowRuns(context.Background(), ListSupersededWorkflowRunsParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: ci.ID,
		TriggerRef:           "refs/heads/main",
		TriggerEvent:         "push",
		NewerRunID:           newest.ID,
	})
	require.NoError(t, err)

	assert.Equal(t, []int64{queuedSameRef.ID, runningSameRef.ID}, ids)
	assert.NotContains(t, ids, succeeded.ID, "a terminal run is not superseded")
	assert.NotContains(t, ids, otherRef.ID, "a different ref is a different concurrency group")
	assert.NotContains(t, ids, manualDispatch.ID, "a manual dispatch run is never auto-cancelled")
	assert.NotContains(t, ids, otherWorkflow.ID, "a different workflow is a different concurrency group")
	assert.NotContains(t, ids, otherRepo.ID, "a different repository is never touched")
	assert.NotContains(t, ids, newest.ID, "a run never supersedes itself")
	assert.NotContains(t, ids, newerStill.ID, "a newer run is never superseded by an older one")
}

func TestMarkWorkflowRunSuperseded_OnlyStampsAFreshlyCancelledRun(t *testing.T) {
	q, pool := newQueries(t)
	fixture := mustCreateWorkflowTaskFixture(t, q, pool, "supersede-reason")
	ctx := context.Background()

	get := func() WorkflowRun {
		t.Helper()
		run, err := q.GetWorkflowRun(ctx, GetWorkflowRunParams{ID: fixture.runID, RepositoryID: fixture.repoID})
		require.NoError(t, err)
		return run
	}

	require.Equal(t, "", get().CancelReason, "a new run carries no cancel reason")

	// A run that is still queued is not stamped: the guard is status = 'cancelled'.
	require.NoError(t, q.MarkWorkflowRunSuperseded(ctx, MarkWorkflowRunSupersededParams{
		ID:           fixture.runID,
		CancelReason: "superseded_by_run:11763",
	}))
	assert.Equal(t, "", get().CancelReason)

	require.NoError(t, q.CancelWorkflowRun(ctx, fixture.runID))
	require.NoError(t, q.MarkWorkflowRunSuperseded(ctx, MarkWorkflowRunSupersededParams{
		ID:           fixture.runID,
		CancelReason: "superseded_by_run:11763",
	}))
	assert.Equal(t, "superseded_by_run:11763", get().CancelReason)

	// First writer wins: a later sweep must not rewrite the recorded reason.
	require.NoError(t, q.MarkWorkflowRunSuperseded(ctx, MarkWorkflowRunSupersededParams{
		ID:           fixture.runID,
		CancelReason: "superseded_by_run:99999",
	}))
	assert.Equal(t, "superseded_by_run:11763", get().CancelReason)
}
