package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"
)

func TestObserveV2DurableInventoryQueries(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := deploymentdb.New(tx)
	before, err := q.GetSandboxInstancesByState(ctx)
	require.NoError(t, err)
	states := map[string]int64{}
	for _, row := range before {
		states[row.ObservedState] = row.Count
	}
	_, err = tx.Exec(ctx, `INSERT INTO sandbox_instances
 (id,provider,provider_local_id,resource_kind,observed_state,reservation_held,deleted_at)
 VALUES
 ('ov2-reserved','test','ov2-reserved','ov2-test','running',true,NULL),
 ('ov2-starting','test','ov2-starting','ov2-test','starting',true,NULL),
 ('ov2-stopped','test','ov2-stopped','ov2-test','stopped',false,NULL),
 ('ov2-deleted','test','ov2-deleted','ov2-test','running',true,NOW())`)
	require.NoError(t, err)
	active, err := q.GetSandboxActiveVMsByKind(ctx)
	require.NoError(t, err)
	found := false
	for _, row := range active {
		if row.Kind == "ov2-test" {
			require.EqualValues(t, 2, row.Count)
			found = true
		}
	}
	require.True(t, found)
	after, err := q.GetSandboxInstancesByState(ctx)
	require.NoError(t, err)
	require.Len(t, after, 11)
	for _, row := range after {
		expected := states[row.ObservedState]
		if row.ObservedState == "running" || row.ObservedState == "starting" || row.ObservedState == "stopped" {
			expected++
		}
		require.Equal(t, expected, row.Count, row.ObservedState)
	}
	_, err = tx.Exec(ctx, `UPDATE sandbox_instances SET reservation_held=false WHERE resource_kind='ov2-test'`)
	require.NoError(t, err)
	active, err = q.GetSandboxActiveVMsByKind(ctx)
	require.NoError(t, err)
	for _, row := range active {
		if row.Kind == "ov2-test" {
			require.Zero(t, row.Count)
		}
	}
}

func TestObserveV2QueueQueriesIncludeDelayedWork(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := deploymentdb.New(tx)
	before, err := q.GetAdminQueueMetrics(ctx)
	require.NoError(t, err)
	require.Len(t, before, 11)
	counts := map[string]int64{}
	for _, row := range before {
		counts[row.Queue] = row.Depth
		require.GreaterOrEqual(t, row.OldestAgeSeconds, 0.0)
		if row.Depth == 0 {
			require.Zero(t, row.OldestAgeSeconds)
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO github_webhook_jobs
 (delivery_id,event_type,payload,status,available_at,created_at)
 VALUES
 (gen_random_uuid(),'test','{}','pending',NOW(),NOW()-interval '2 hours'),
 (gen_random_uuid(),'test','{}','pending',NOW()+interval '1 hour',NOW()-interval '1 hour'),
 (gen_random_uuid(),'test','{}','done',NOW(),NOW()-interval '3 hours')`)
	require.NoError(t, err)
	after, err := q.GetAdminQueueMetrics(ctx)
	require.NoError(t, err)
	for _, row := range after {
		if row.Queue == "github_webhook_jobs" {
			require.Equal(t, counts[row.Queue]+2, row.Depth)
			require.GreaterOrEqual(t, row.OldestAgeSeconds, 7200.0)
		} else {
			require.Equal(t, counts[row.Queue], row.Depth, row.Queue)
		}
	}
}
