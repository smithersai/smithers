package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type conditionalFailureWorkspaceQuerier struct {
	*mockWorkspaceQuerier
	failUnchangedFn    func(context.Context, db.FailWorkspaceIfUnchangedParams) (db.Workspace, error)
	failProvisioningFn func(context.Context, db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error)
}

func (q *conditionalFailureWorkspaceQuerier) FailWorkspaceIfUnchanged(ctx context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
	return q.failUnchangedFn(ctx, arg)
}

func (q *conditionalFailureWorkspaceQuerier) FailProvisioningWorkspaceIfCurrent(ctx context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error) {
	return q.failProvisioningFn(ctx, arg)
}

func TestWorkspaceFailureCallsitesUseConditionalTransitions(t *testing.T) {
	t.Parallel()
	stale := sampleDBWorkspace("ws-failure-cas")
	stale.Status = "starting"
	stale.VmID = ""

	var staleArgs []db.FailWorkspaceIfUnchangedParams
	var provisioningArgs []db.FailProvisioningWorkspaceIfCurrentParams
	base := &mockWorkspaceQuerier{
		listStalePendingWorkspacesFn: func(context.Context, int32) ([]db.Workspace, error) {
			return []db.Workspace{stale}, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			t.Fatal("unfenced UpdateWorkspaceStatus fallback must not run in production-capable stores")
			return db.Workspace{}, nil
		},
	}
	q := &conditionalFailureWorkspaceQuerier{
		mockWorkspaceQuerier: base,
		failUnchangedFn: func(_ context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
			staleArgs = append(staleArgs, arg)
			return db.Workspace{}, pgx.ErrNoRows // provisioner won after the stale list
		},
		failProvisioningFn: func(_ context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error) {
			provisioningArgs = append(provisioningArgs, arg)
			return db.Workspace{}, pgx.ErrNoRows // finalizer already made it running
		},
	}
	svc := newWorkspaceServiceForTests(q)
	require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
	require.Len(t, staleArgs, 1)
	assert.Equal(t, stale.Status, staleArgs[0].ExpectedStatus)
	assert.Equal(t, stale.VmID, staleArgs[0].ExpectedVmID)
	assert.Equal(t, stale.UpdatedAt, staleArgs[0].ExpectedUpdatedAt)
	assert.Equal(t, string(workspaceProvisioningFailureCode), staleArgs[0].FailureCode)
	assert.Equal(t, "workspace provisioning timed out", staleArgs[0].FailureMessage)

	svc.markWorkspaceProvisionFailed(context.Background(), stale, context.DeadlineExceeded)
	require.Len(t, provisioningArgs, 1)
	assert.Equal(t, stale.Status, provisioningArgs[0].ExpectedStatus)
	assert.Equal(t, stale.VmID, provisioningArgs[0].ExpectedVmID)
	assert.Equal(t, stale.UpdatedAt, provisioningArgs[0].ExpectedUpdatedAt)
	assert.Equal(t, string(workspaceProvisioningFailureCode), provisioningArgs[0].FailureCode)
	assert.Equal(t, context.DeadlineExceeded.Error(), provisioningArgs[0].FailureMessage)
}
