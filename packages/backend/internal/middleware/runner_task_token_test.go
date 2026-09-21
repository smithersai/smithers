package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type runnerTaskTokenTestQuerier struct {
	run     db.WorkflowRun
	task    db.GetWorkflowTaskForRunnerRow
	taskErr error
}

func (q runnerTaskTokenTestQuerier) GetWorkflowRunByAgentToken(context.Context, pgtype.Text) (db.WorkflowRun, error) {
	return db.WorkflowRun{}, nil
}

func (q runnerTaskTokenTestQuerier) GetWorkflowRunByRunID(context.Context, int64) (db.WorkflowRun, error) {
	return q.run, nil
}

func (q runnerTaskTokenTestQuerier) GetWorkflowTaskForRunner(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
	return q.task, q.taskErr
}

func TestRunnerTaskToken_AuthenticatesWithoutRevealingSharedCredential(t *testing.T) {
	shared := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	t.Setenv("SMITHERS_AGENT_TOKEN", shared)
	claims := RunnerTaskTokenClaims{
		TaskID: 55, WorkflowRunID: 12, RepositoryID: 101, RunnerID: 7, Attempt: 1,
		ExpiresAtUnix: time.Now().Add(time.Hour).Unix(),
	}
	token, err := MintRunnerTaskToken(shared, claims)
	require.NoError(t, err)
	assert.NotContains(t, token, shared)

	handler := RequireAgentToken(runnerTaskTokenTestQuerier{
		run: db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "running"},
		task: db.GetWorkflowTaskForRunnerRow{
			ID: 55, WorkflowRunID: 12, RepositoryID: 101,
			RunnerID: pgtype.Int8{Int64: 7, Valid: true}, Status: "running", Attempt: 1,
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.False(t, IsSharedAgentToken(r.Context()))
		assert.Equal(t, token, AgentTokenFromContext(r.Context()))
		got, ok := RunnerTaskTokenFromContext(r.Context())
		require.True(t, ok)
		assert.Equal(t, claims, got)
		run := WorkflowRunFromContext(r.Context())
		require.NotNil(t, run)
		assert.Equal(t, int64(12), run.ID)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/internal/tasks/55/stream", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	assert.Equal(t, http.StatusNoContent, response.Code)

	// A task token is not the runner-control credential and cannot call the
	// lifecycle group guarded by an exact shared bearer comparison.
	called := false
	lifecycle := RequireSharedBearerToken(shared)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	lifecycleResponse := httptest.NewRecorder()
	lifecycle.ServeHTTP(lifecycleResponse, req)
	assert.Equal(t, http.StatusUnauthorized, lifecycleResponse.Code)
	assert.False(t, called)
}

func TestRunnerTaskToken_RejectsTamperingExpiryAndRunMismatch(t *testing.T) {
	shared := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	t.Setenv("SMITHERS_AGENT_TOKEN", shared)
	base := RunnerTaskTokenClaims{
		TaskID: 55, WorkflowRunID: 12, RepositoryID: 101, RunnerID: 7, Attempt: 1,
		ExpiresAtUnix: time.Now().Add(time.Hour).Unix(),
	}

	requestStatus := func(t *testing.T, token string, run db.WorkflowRun) int {
		t.Helper()
		handler := RequireAgentToken(runnerTaskTokenTestQuerier{
			run: run,
			task: db.GetWorkflowTaskForRunnerRow{
				ID: 55, WorkflowRunID: 12, RepositoryID: 101,
				RunnerID: pgtype.Int8{Int64: 7, Valid: true}, Status: "running", Attempt: 1,
			},
		})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response.Code
	}

	valid, err := MintRunnerTaskToken(shared, base)
	require.NoError(t, err)
	tampered := valid + "x"
	assert.Equal(t, http.StatusUnauthorized, requestStatus(t, tampered, db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "running"}))

	expiredClaims := base
	expiredClaims.ExpiresAtUnix = time.Now().Add(-time.Minute).Unix()
	expired, err := MintRunnerTaskToken(shared, expiredClaims)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, requestStatus(t, expired, db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "running"}))

	assert.Equal(t, http.StatusUnauthorized, requestStatus(t, valid, db.WorkflowRun{ID: 12, RepositoryID: 999, Status: "running"}))
	assert.Equal(t, http.StatusUnauthorized, requestStatus(t, valid, db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "success"}))
}

func TestRunnerTaskToken_RejectsImmediatelyAfterClaimedTaskStopsRunning(t *testing.T) {
	shared := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	t.Setenv("SMITHERS_AGENT_TOKEN", shared)
	token, err := MintRunnerTaskToken(shared, RunnerTaskTokenClaims{
		TaskID: 55, WorkflowRunID: 12, RepositoryID: 101, RunnerID: 7, Attempt: 1,
		ExpiresAtUnix: time.Now().Add(time.Hour).Unix(),
	})
	require.NoError(t, err)

	querier := runnerTaskTokenTestQuerier{
		run:     db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "running"},
		taskErr: pgx.ErrNoRows, // GetWorkflowTaskForRunner filters status != running.
	}
	called := false
	handler := RequireAgentToken(querier)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/internal/caches/save", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)

	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.False(t, called, "completed task tokens must be rejected before cache/artifact handlers run")
}

func TestRunnerTaskToken_RejectsEarlierAttemptAfterSameRunnerReclaimsTask(t *testing.T) {
	shared := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	t.Setenv("SMITHERS_AGENT_TOKEN", shared)
	token, err := MintRunnerTaskToken(shared, RunnerTaskTokenClaims{
		TaskID: 55, WorkflowRunID: 12, RepositoryID: 101, RunnerID: 7, Attempt: 1,
		ExpiresAtUnix: time.Now().Add(time.Hour).Unix(),
	})
	require.NoError(t, err)

	// Requeue + reclaim can assign the same task to the same runner ID. The
	// incremented attempt is the only value that distinguishes the old lease.
	querier := runnerTaskTokenTestQuerier{
		run: db.WorkflowRun{ID: 12, RepositoryID: 101, Status: "running"},
		task: db.GetWorkflowTaskForRunnerRow{
			ID: 55, WorkflowRunID: 12, RepositoryID: 101,
			RunnerID: pgtype.Int8{Int64: 7, Valid: true}, Status: "running", Attempt: 2,
		},
	}
	called := false
	handler := RequireAgentToken(querier)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/internal/tasks/55/stream", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)

	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.False(t, called, "a token from an earlier task lease must never revive")
}
