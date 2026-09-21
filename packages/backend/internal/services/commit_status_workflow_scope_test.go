package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A commit status must not reference a workflow_run_id owned by another
// repository. GetWorkflowRun is scoped by (id, repository_id), so a cross-repo
// run id returns ErrNoRows and the status creation must be rejected — otherwise a
// writer on repo A could attach repo B's (another tenant's) workflow run.
func TestCommitStatusService_RejectsCrossRepoWorkflowRun(t *testing.T) {
	t.Parallel()

	var lookedUp db.GetWorkflowRunParams
	crossRepoRun := int64(999)
	mock := &mockCommitStatusQuerier{
		getWorkflowRunFn: func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
			lookedUp = arg
			return db.WorkflowRun{}, pgx.ErrNoRows // not owned by the target repo
		},
	}
	svc := NewCommitStatusService(mock)

	_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
		Context:       "ci/build",
		Status:        "success",
		WorkflowRunID: &crossRepoRun,
	})

	assert.Equal(t, 422, commitStatusAPIStatus(t, err))
	assert.Equal(t, 0, mock.createCallCount, "commit status must not be created for a cross-repo workflow run")
	assert.Equal(t, int64(10), lookedUp.RepositoryID, "workflow run lookup must be scoped to the target repository")
	assert.Equal(t, crossRepoRun, lookedUp.ID)
}
