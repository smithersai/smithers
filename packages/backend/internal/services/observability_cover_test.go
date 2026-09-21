package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestObservability_Cov_RuntimeMetricsStoreDatabaseBranches(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	userID, repoID := observabilityCovSeedUserRepo(t, ctx)

	_, err := pool.Exec(ctx, `INSERT INTO runner_pool (name, status, metadata) VALUES ($1, 'idle', '{}'::jsonb)`, "cov-runner-"+strings.ReplaceAll(uuid.NewString(), "-", ""))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO agent_sessions (id, repository_id, user_id, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', NOW() - INTERVAL '90 seconds', NOW())`, uuid.NewString(), repoID, userID)
	require.NoError(t, err)

	store := NewRuntimeMetricsStore(queries, pool)
	idle, err := store.CountRunners(ctx, "idle")
	require.NoError(t, err)
	assert.GreaterOrEqual(t, idle, int64(1))

	active, err := store.CountActiveAgentSessions(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, active, int64(1))

	oldest, err := store.GetActiveAgentSessionOldestAgeSeconds(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, oldest, 0.0)

	queue, err := store.GetWorkflowTaskQueueMetrics(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, queue.Depth, int64(0))
	assert.GreaterOrEqual(t, queue.OldestAgeSeconds, 0.0)
}

func TestObservability_Cov_NilStoresAndNegativeDurationBranches(t *testing.T) {
	nilStore := NewRuntimeMetricsStore(nil, nil)
	runners, err := nilStore.CountRunners(context.Background(), "idle")
	require.NoError(t, err)
	assert.Equal(t, int64(0), runners)

	active, err := nilStore.CountActiveAgentSessions(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(0), active)

	oldest, err := nilStore.GetActiveAgentSessionOldestAgeSeconds(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0.0, oldest)

	queue, err := nilStore.GetWorkflowTaskQueueMetrics(context.Background())
	require.NoError(t, err)
	assert.Equal(t, WorkflowTaskQueueMetrics{}, queue)

	observer := &fakeWorkflowRunMetricsObserver{}
	observeWorkflowRunCompletion(observer, db.WorkflowRun{
		ID:        99,
		Status:    "running",
		CreatedAt: time.Now().Add(time.Hour),
	}, "success")
	assert.Equal(t, 0, observer.count)

	StartRuntimeMetricsCollector(context.Background(), nil, &fakeRuntimeMetricsObserver{}, time.Millisecond)
	StartRuntimeMetricsCollector(context.Background(), &fakeRuntimeMetricsStore{}, nil, time.Millisecond)
}

func observabilityCovSeedUserRepo(t *testing.T, ctx context.Context) (int64, int64) {
	t.Helper()
	pool := getAgentTestPool(t)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	username := "obs_" + suffix[:12]
	var userID int64
	err := pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, display_name) VALUES ($1, $1, $1) RETURNING id`, username).Scan(&userID)
	require.NoError(t, err)

	repoName := "repo_" + suffix[:12]
	var repoID int64
	err = pool.QueryRow(ctx, `INSERT INTO repositories (user_id, name, lower_name, storage_set_id) VALUES ($1, $2, $2, 's1') RETURNING id`, userID, repoName).Scan(&repoID)
	require.NoError(t, err)
	return userID, repoID
}

func TestObservability_Cov_StartedAtDurationBranch(t *testing.T) {
	observer := &fakeWorkflowRunMetricsObserver{}
	run := db.WorkflowRun{
		ID:        101,
		Status:    "running",
		CreatedAt: time.Now().Add(-10 * time.Second),
		StartedAt: pgtype.Timestamptz{Time: time.Now().Add(-2 * time.Second), Valid: true},
	}

	observeWorkflowRunCompletion(observer, run, "failed")
	require.Equal(t, 0, observer.count)

	observeWorkflowRunCompletion(observer, run, "failure")
	require.Equal(t, 1, observer.count)
	assert.Equal(t, "failure", observer.status)
	assert.Less(t, observer.seconds, 5.0)
}
