package clusterservices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type gvisorRunnerContractQuerier struct {
	*mockRunnerQuerier
}

func (q *gvisorRunnerContractQuerier) GetWorkflowRunByAgentToken(context.Context, pgtype.Text) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func TestRunnerService_GetTaskRuntimeEnvironment_SharedPodTokenRequiresRunningTask(t *testing.T) {
	t.Parallel()

	t.Run("claimed running task receives its repository environment", func(t *testing.T) {
		t.Parallel()
		queriedRunScoped := false
		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
				assert.Equal(t, int64(55), taskID)
				return db.GetWorkflowTaskForRunnerRow{
					ID:            55,
					WorkflowRunID: 12,
					RepositoryID:  101,
					RunnerID:      pgtype.Int8{Int64: 7, Valid: true},
					Status:        "running",
					Attempt:       1,
				}, nil
			},
			getWorkflowTaskRuntimeContextFn: func(context.Context, db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
				queriedRunScoped = true
				return db.GetWorkflowTaskRuntimeContextRow{}, nil
			},
		}, WithRunnerSecretInjector(services.NewSecretInjector(&mockSecretInjectionQuerier{
			listVariablesFn: func(_ context.Context, repositoryID int64) ([]db.RepositoryVariable, error) {
				assert.Equal(t, int64(101), repositoryID)
				return []db.RepositoryVariable{{Name: "CI_MODE", Value: "strict"}}, nil
			},
		}, webhook.NoopSecretCodec{})))

		ctx := middleware.ContextWithAgentToken(context.Background(), "smithers_agent_shared")
		ctx = middleware.ContextWithSharedAgentToken(ctx)
		env, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
		require.NoError(t, err)
		assert.Equal(t, "strict", env["CI_MODE"])
		assert.NotEqual(t, "smithers_agent_shared", env["SMITHERS_AGENT_TOKEN"])
		assert.Contains(t, env["SMITHERS_AGENT_TOKEN"], "smithers_task_v1.")
		assert.False(t, queriedRunScoped, "shared bootstrap must use the running-task query")
	})

	t.Run("unclaimed or terminal task is hidden", func(t *testing.T) {
		t.Parallel()
		svc := NewRunnerService(&mockRunnerQuerier{
			getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
				return db.GetWorkflowTaskForRunnerRow{}, pgx.ErrNoRows
			},
		})
		ctx := middleware.ContextWithSharedAgentToken(context.Background())
		_, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
		require.Error(t, err)
		apiErr, ok := err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 404, apiErr.Status)
	})
}

func TestRunnerTaskCredential_CannotSettleAnyTask(t *testing.T) {
	t.Parallel()

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12, RepositoryID: 101})
	ctx = middleware.ContextWithRunnerTaskToken(ctx, middleware.RunnerTaskTokenClaims{
		TaskID: 55, WorkflowRunID: 12, RepositoryID: 101, RunnerID: 7,
	})
	svc := NewRunnerService(&mockRunnerQuerier{})

	_, err := svc.GetTaskRuntimeEnvironment(ctx, 56)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)

	for _, input := range []RunnerCompleteTaskInput{
		// Even an exact match is malicious: only the trusted parent observes the
		// child exit and completes quarantine before settlement.
		{TaskID: 55, RunnerID: 7, Status: "done"},
		{TaskID: 55, RunnerID: 8, Status: "done"},
	} {
		err = svc.CompleteTask(ctx, input)
		require.Error(t, err)
		apiErr, ok = err.(*pkgerrors.APIError)
		require.True(t, ok)
		assert.Equal(t, 403, apiErr.Status)
	}
}

func TestGVisorRunnerCredential_EndToEndBootstrapAndCrossTaskRejection(t *testing.T) {
	shared := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	t.Setenv("SMITHERS_AGENT_TOKEN", shared)

	querier := &gvisorRunnerContractQuerier{mockRunnerQuerier: &mockRunnerQuerier{
		getWorkflowTaskFn: func(_ context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error) {
			if taskID != 55 {
				return db.GetWorkflowTaskForRunnerRow{}, pgx.ErrNoRows
			}
			return db.GetWorkflowTaskForRunnerRow{
				ID: 55, WorkflowRunID: 12, RepositoryID: 101,
				RunnerID: pgtype.Int8{Int64: 7, Valid: true}, Status: "running", Attempt: 1,
			}, nil
		},
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			if arg.TaskID != 55 || arg.WorkflowRunID != 12 {
				return db.GetWorkflowTaskRuntimeContextRow{}, pgx.ErrNoRows
			}
			return db.GetWorkflowTaskRuntimeContextRow{
				ID: 55, WorkflowRunID: 12, RepositoryID: 101, Status: "running",
			}, nil
		},
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: runID, RepositoryID: 101, Status: "running"}, nil
		},
	}}
	svc := NewRunnerService(querier)

	bootstrapCtx := middleware.ContextWithAgentToken(context.Background(), shared)
	bootstrapCtx = middleware.ContextWithSharedAgentToken(bootstrapCtx)
	env, err := svc.GetTaskRuntimeEnvironment(bootstrapCtx, 55)
	require.NoError(t, err)
	taskToken := env["SMITHERS_AGENT_TOKEN"]
	require.NotEmpty(t, taskToken)
	assert.NotEqual(t, shared, taskToken)

	handlerForTask := func(taskID int64) http.Handler {
		return middleware.RequireAgentToken(querier)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			result, err := svc.GetTaskRuntimeEnvironment(r.Context(), taskID)
			if err != nil {
				apiErr, ok := err.(*pkgerrors.APIError)
				if !ok {
					http.Error(w, "internal", http.StatusInternalServerError)
					return
				}
				http.Error(w, apiErr.Message, apiErr.Status)
				return
			}
			assert.Equal(t, taskToken, result["SMITHERS_AGENT_TOKEN"])
			w.WriteHeader(http.StatusNoContent)
		}))
	}

	request := func(taskID int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/internal/tasks/env", nil)
		req.Header.Set("Authorization", "Bearer "+taskToken)
		response := httptest.NewRecorder()
		handlerForTask(taskID).ServeHTTP(response, req)
		return response
	}

	assert.Equal(t, http.StatusNoContent, request(55).Code)
	assert.Equal(t, http.StatusNotFound, request(56).Code)
}

func TestRunnerService_GetTaskRuntimeEnvironment_RunTokenNeverFallsBackToSharedLookup(t *testing.T) {
	t.Parallel()

	sharedLookup := false
	svc := NewRunnerService(&mockRunnerQuerier{
		getWorkflowTaskFn: func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			sharedLookup = true
			return db.GetWorkflowTaskForRunnerRow{}, nil
		},
		getWorkflowTaskRuntimeContextFn: func(_ context.Context, arg db.GetWorkflowTaskRuntimeContextParams) (db.GetWorkflowTaskRuntimeContextRow, error) {
			assert.Equal(t, int64(12), arg.WorkflowRunID)
			return db.GetWorkflowTaskRuntimeContextRow{}, pgx.ErrNoRows
		},
	})

	ctx := middleware.ContextWithWorkflowRun(context.Background(), &db.WorkflowRun{ID: 12})
	_, err := svc.GetTaskRuntimeEnvironment(ctx, 55)
	require.Error(t, err)
	assert.False(t, sharedLookup)
}
