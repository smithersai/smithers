package clusterservices

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
)

func runnerQueueTimeoutPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("SMITHERS_CLUSTER_TEST_DATABASE_URL"))
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_CLUSTER_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_CLUSTER_TEST_DATABASE_URL for cluster database integration")
	}
	schema, err := os.ReadFile(filepath.Join("..", "..", "db", "cluster", "sqlc_schema.sql"))
	require.NoError(t, err)
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(raw)
	require.NoError(t, err)
	adminConfig := config.Copy()
	adminConfig.ConnConfig.Database = "postgres"
	admin, err := pgxpool.NewWithConfig(ctx, adminConfig)
	require.NoError(t, err)
	require.NoError(t, admin.Ping(ctx))
	name := "runner_timeout_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	config.ConnConfig.Database = name
	config.AfterConnect = func(_ context.Context, conn *pgx.Conn) error { database.ConfigureSQLCTypes(conn.TypeMap()); return nil }
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, dropErr := admin.Exec(cleanupCtx, `DROP DATABASE `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`)
		admin.Close()
		require.NoError(t, dropErr)
	})
	require.NoError(t, pool.Ping(ctx))
	_, err = pool.Exec(ctx, string(schema))
	require.NoError(t, err)
	return pool
}

func runnerQueueTimeoutFixture(t *testing.T) (*pgxpool.Pool, *deploymentdb.Queries, int64, int64, int64, int64) {
	t.Helper()
	pool := runnerQueueTimeoutPool(t)
	q := deploymentdb.New(pool)
	repoID := createRunnerIntegrationRepo(t, pool)
	runID, _, tasks := createWorkflowRunWithDependentSteps(t, q, pool, repoID)
	runner, err := q.UpsertRunner(context.Background(), clusterdb.UpsertRunnerParams{Name: fmt.Sprintf("timeout-runner-%d", time.Now().UnixNano()), Metadata: []byte(`{}`)})
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE workflow_runs SET execution_plane = 'runner' WHERE id = $1`, runID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE workflow_tasks SET available_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`, tasks[0])
	require.NoError(t, err)
	return pool, q, repoID, runID, tasks[0], runner.ID
}

func TestRunnerQueueTimeout_MarkedRunCannotBeClaimedInCluster(t *testing.T) {
	_, q, repoID, runID, _, runnerID := runnerQueueTimeoutFixture(t)
	ctx := context.Background()
	marked, err := q.MarkQueuedRunnerWorkflowRunTimeout(ctx, clusterdb.MarkQueuedRunnerWorkflowRunTimeoutParams{RunID: runID, RepositoryID: repoID})
	require.NoError(t, err)
	require.EqualValues(t, 1, marked)
	_, err = q.ClaimRunnerWorkflowTask(ctx, runnerID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestRunnerQueueTimeout_ClaimWinningRunLockCannotBeExpiredInCluster(t *testing.T) {
	pool, q, repoID, runID, taskID, runnerID := runnerQueueTimeoutFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	claim, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer claim.Rollback(context.Background())
	claimed, err := clusterdb.New(claim).ClaimRunnerWorkflowTask(ctx, runnerID)
	require.NoError(t, err)
	require.Equal(t, taskID, claimed.ID)
	marker, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer marker.Release()
	type result struct {
		marked int64
		err    error
	}
	results := make(chan result, 1)
	go func() {
		marked, err := clusterdb.New(marker).MarkQueuedRunnerWorkflowRunTimeout(ctx, clusterdb.MarkQueuedRunnerWorkflowRunTimeoutParams{RunID: runID, RepositoryID: repoID})
		results <- result{marked, err}
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type = 'Lock', false) FROM pg_stat_activity WHERE pid = $1`, marker.Conn().PgConn().PID()).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, claim.Commit(ctx))
	select {
	case got := <-results:
		require.NoError(t, got.err)
		require.Zero(t, got.marked)
	case <-ctx.Done():
		t.Fatal("expiry did not finish")
	}
	_ = q
}
