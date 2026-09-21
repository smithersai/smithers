package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Regression tests for the dual-executor race: every run must be created with
// the execution plane that matches its single legitimate executor, so the
// sandbox whole-workflow scheduler and the gVisor task runner can never both
// claim work for the same run.

func dispatchExecutionPlaneRun(t *testing.T, config string, opts ...WorkflowRunServiceOption) db.CreateWorkflowRunParams {
	t.Helper()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, config)}, nil
		},
	}
	svc := NewWorkflowRunService(mock, opts...)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "cafebabe"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createRunCalls, 1)
	return mock.createRunCalls[0]
}

// Owner decision (2026-09-15): CI belongs on a NixOS guest built from the
// repository's own .smithers/environment.nix. These two tests pin the routing
// rule at the dispatch boundary, where the plane becomes immutable.

func TestDispatchForEvent_NixOSRepositoryRoutesToSandboxPlane(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{}}}`,
		WithWorkflowRunEnvironmentRouting(declaredEnvironmentProbe(), &fakeEnvironmentImageResolver{image: repoScopedImage(42)}))
	assert.Equal(t, WorkflowRunPlaneSandbox, created.ExecutionPlane,
		"a repository that declares and has built its environment runs CI in NixOS guests")
}

func TestDispatchForEvent_RepositoryWithoutClosureImageFallsBackToRunner(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{}}}`,
		WithWorkflowRunEnvironmentRouting(declaredEnvironmentProbe(), &fakeEnvironmentImageResolver{err: pkgerrors.NotFound("no image")}))
	assert.Equal(t, WorkflowRunPlaneRunner, created.ExecutionPlane,
		"the Debian runner pool is the fallback until the repository's closure is registered")
}

func TestDispatchForEvent_StandardCIRunIsRunnerPlane(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{}}}`)
	assert.Equal(t, WorkflowRunPlaneRunner, created.ExecutionPlane,
		"standard CI must execute only on the gVisor task runner plane")
}

func TestDispatchForEvent_RunsOnCannotSelectSandboxPlane(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"microsandbox"},"test":{"runs-on":"sandbox"}}}`)
	assert.Equal(t, WorkflowRunPlaneRunner, created.ExecutionPlane,
		"CI must stay on the gVisor runner; Microsandbox is reserved for agents and workspaces")
}

func TestDispatchForEvent_MixedRunsOnFallsBackToRunnerPlane(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{"runs-on":"microsandbox"},"test":{}}}`)
	assert.Equal(t, WorkflowRunPlaneRunner, created.ExecutionPlane)
}

func TestDispatchAgentRun_CreatesAgentPlaneRun(t *testing.T) {
	t.Parallel()

	var created *db.CreateWorkflowRunParams
	dq := &mockAgentDispatchQuerier{
		createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			created = &arg
			return db.WorkflowRun{ID: 10, RepositoryID: arg.RepositoryID, Status: arg.Status, ExecutionPlane: arg.ExecutionPlane}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.q = &mockAgentQuerier{
		getAgentSessionWorkflowRunIDFn: func(_ context.Context, _ string) (pgtype.Int8, error) {
			return pgtype.Int8{}, nil
		},
	}

	_, _ = svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-plane",
		RepositoryID: 101,
		UserID:       7,
	})

	require.NotNil(t, created, "agent dispatch must create a workflow run")
	assert.Equal(t, WorkflowRunPlaneAgent, created.ExecutionPlane,
		"agent runs must be claimable by neither the task runner nor the sandbox scheduler")
}
