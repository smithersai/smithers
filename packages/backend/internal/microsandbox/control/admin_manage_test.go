package control

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAdminDrainHostUsesStickyControllerState(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	s := NewPGStore(pool)
	_, err := s.Heartbeat(ctx, heartbeatForTest("drain-admin", "https://worker.internal"))
	require.NoError(t, err)
	require.NoError(t, s.DrainHost(ctx, "drain-admin"))
	require.NoError(t, s.DrainHost(ctx, "drain-admin"))
	h, err := s.Heartbeat(ctx, heartbeatForTest("drain-admin", "https://worker.internal"))
	require.NoError(t, err)
	require.Equal(t, "draining", h.State)
	require.False(t, h.AdmitNew)
	require.True(t, h.Authorized)
	require.ErrorIs(t, s.DrainHost(ctx, "missing"), ErrNotFound)
	// A live lease but a state with nothing to drain: the operator asked for
	// something that does not apply to this host.
	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='fenced' WHERE id='drain-admin'`)
	require.NoError(t, err)
	require.ErrorIs(t, s.DrainHost(ctx, "drain-admin"), ErrHostNotDrainable)
	// An expired lease is a different verdict, and this test already set it up
	// separately while asserting the same one: the controller no longer owns
	// the host, so it cannot drain it. That is plue losing a machine, not the
	// operator's request conflicting with anything.
	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET state='ready',lease_expires_at=now()-interval '1 second' WHERE id='drain-admin'`)
	require.NoError(t, err)
	require.ErrorIs(t, s.DrainHost(ctx, "drain-admin"), ErrHostLeaseLost)
}
func TestAdminPruneStaleHostsRequiresOldLeaseAndNoLiveInstances(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	s := NewPGStore(pool)
	q := clusterdb.New(pool)
	for _, id := range []string{"old-empty", "old-live", "old-deleted", "recent-empty", "live-empty"} {
		_, err := s.Heartbeat(ctx, heartbeatForTest(id, "https://worker.internal"))
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `UPDATE sandbox_hosts SET lease_expires_at=now()-interval '25 hours' WHERE id LIKE 'old-%'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE sandbox_hosts SET lease_expires_at=now()-interval '23 hours' WHERE id='recent-empty'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO sandbox_instances(id,provider,provider_local_id,worker_id,observed_state,deleted_at) VALUES ('live','microsandbox','live','old-live','stopped',NULL),('deleted','microsandbox','deleted','old-deleted','deleted',$1)`, time.Now())
	require.NoError(t, err)
	rows, err := q.AdminListSandboxHosts(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 5)
	for _, r := range rows {
		if r.SandboxHost.ID == "old-live" {
			require.EqualValues(t, 1, r.InstanceCount)
		}
	}
	// A failed audit insert must roll back the deletion, preserving targets for retry.
	_, err = q.AdminPruneStaleSandboxHosts(ctx, clusterdb.AdminPruneStaleSandboxHostsParams{OlderThanHours: 24, IpAddress: strings.Repeat("x", 46)})
	require.Error(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sandbox_hosts`).Scan(&count))
	require.Equal(t, 5, count)
	n, err := q.AdminPruneStaleSandboxHosts(ctx, clusterdb.AdminPruneStaleSandboxHostsParams{OlderThanHours: 24})
	require.NoError(t, err)
	require.EqualValues(t, 2, n)
	var metadata string
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata::text FROM audit_log`).Scan(&metadata))
	require.JSONEq(t, `{"outcome":"succeeded","older_than_hours":24,"pruned":2,"host_ids":["old-deleted","old-empty"]}`, metadata)
	n, err = q.AdminPruneStaleSandboxHosts(ctx, clusterdb.AdminPruneStaleSandboxHostsParams{OlderThanHours: 24})
	require.NoError(t, err)
	require.Zero(t, n)
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata::text FROM audit_log ORDER BY id LIMIT 1`).Scan(&metadata))
	require.Contains(t, metadata, "old-deleted")
	require.Contains(t, metadata, "old-empty")
	var ids []string
	rs, err := pool.Query(ctx, `SELECT id FROM sandbox_hosts ORDER BY id`)
	require.NoError(t, err)
	defer rs.Close()
	for rs.Next() {
		var id string
		require.NoError(t, rs.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, rs.Err())
	require.Equal(t, []string{"live-empty", "old-live", "recent-empty"}, ids)
}

func TestAdminNeverStartedQueryGuardsAndPreservesMetadata(t *testing.T) {
	pool := openMicrosandboxTestDatabase(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO users(id, username, lower_username) VALUES (1, 'sandbox-test', 'sandbox-test')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO repositories(id, user_id, name, lower_name) VALUES (1, 1, 'sandbox-test', 'sandbox-test')`)
	require.NoError(t, err)
	ids := []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"}
	for _, id := range ids {
		_, err = pool.Exec(ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status,metadata,created_at) VALUES ($1,1,1,'active','{"keep":"value"}',now()-interval '2 hours')`, id)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=now() WHERE id=$1`, ids[1])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET created_at=now() WHERE id=$1`, ids[2])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET deleted_at=now() WHERE id=$1`, ids[3])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET status='completed' WHERE id=$1`, ids[4])
	require.NoError(t, err)
	q := db.New(pool)
	cutoff := time.Now().UTC().Add(-time.Hour)
	rows, err := q.ListNeverStartedAgentSessions(ctx, cutoff)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, ids[0], rows[0].ID)
	// A runner starts after listing but before the update; it must win.
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=now() WHERE id=$1`, ids[0])
	require.NoError(t, err)
	_, err = q.FailNeverStartedAgentSession(ctx, db.FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=NULL WHERE id=$1`, ids[0])
	require.NoError(t, err)
	failed, err := q.FailNeverStartedAgentSession(ctx, db.FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.NoError(t, err)
	require.Equal(t, "failed", failed.Status)
	require.True(t, failed.FinishedAt.Valid)
	require.JSONEq(t, `{"keep":"value","failure_reason":"never_started"}`, string(failed.Metadata))
	_, err = q.FailNeverStartedAgentSession(ctx, db.FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}
