package db

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSumSandboxAwakeSecondsForUserSince(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	user := mustCreateUser(t, tx, "meter-sum")
	other := mustCreateUser(t, tx, "meter-other")
	var now time.Time
	require.NoError(t, tx.QueryRow(ctx, `SELECT now()`).Scan(&now))
	_, err := tx.Exec(ctx, `INSERT INTO sandbox_usage_intervals (user_id, sandbox_kind, sandbox_id, started_at, ended_at) VALUES
 ($1,'workspace','closed',now()-interval '2 hours',now()-interval '30 minutes'),
 ($1,'agent','open',now()-interval '15 minutes',NULL),
 ($1,'gateway','old',now()-interval '3 hours',now()-interval '2 hours'),
 ($1,'workspace','future-end',now()-interval '5 minutes',now()+interval '1 hour'),
 ($1,'workspace','future-start',now()+interval '1 hour',NULL),
 ($2,'agent','other-user',now()-interval '1 hour',NULL)`, user, other)
	require.NoError(t, err)
	seconds, err := q.SumSandboxAwakeSecondsForUserSince(ctx, user, now.Add(-time.Hour))
	require.NoError(t, err)
	require.Equal(t, int64(1800+900+300), seconds)
	seconds, err = q.SumSandboxAwakeSecondsForUserSince(ctx, user, now.Add(time.Hour))
	require.NoError(t, err)
	require.Zero(t, seconds)
}

func TestCountActiveAgentSessionVMsForUser(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	user, repo := mustCreateUserAndRepo(t, tx, "meter-count", "meter-repo")
	other := mustCreateUser(t, tx, "meter-count-other")
	for _, tc := range []struct {
		name, status                 string
		started, deleted             bool
		workspaceStatus, link        string
		workspaceDeleted, otherOwner bool
		want                         int64
	}{
		{name: "reserved", status: "active", started: true, want: 1},
		{name: "never dispatched", status: "active", want: 0},
		{name: "finished", status: "completed", started: true, want: 0},
		{name: "deleted", status: "active", started: true, deleted: true, want: 0},
		{name: "session backlink", status: "active", started: true, workspaceStatus: "running", link: "session", want: 0},
		{name: "workspace forward link", status: "active", started: true, workspaceStatus: "starting", link: "workspace", want: 0},
		{name: "pending reservation", status: "active", started: true, workspaceStatus: "pending", link: "both", want: 0},
		{name: "suspended workspace", status: "active", started: true, workspaceStatus: "suspended", link: "both", want: 1},
		{name: "deleted workspace", status: "active", started: true, workspaceStatus: "running", link: "both", workspaceDeleted: true, want: 1},
		{name: "other owner workspace", status: "active", started: true, workspaceStatus: "running", link: "both", otherOwner: true, want: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tx.Exec(ctx, `DELETE FROM workspaces; DELETE FROM agent_sessions`)
			require.NoError(t, err)
			var session string
			require.NoError(t, tx.QueryRow(ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status,started_at,deleted_at)
    VALUES(gen_random_uuid(),$1,$2,$3,CASE WHEN $4 THEN now() END,CASE WHEN $5 THEN now() END) RETURNING id`, repo, user, tc.status, tc.started, tc.deleted).Scan(&session))
			if tc.link != "" {
				owner := user
				if tc.otherOwner {
					owner = other
				}
				var workspace string
				require.NoError(t, tx.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,status,kind,agent_session_id,deleted_at)
     VALUES($1,$2,$3,'agent',CASE WHEN $4 THEN $5::uuid END,CASE WHEN $6 THEN now() END) RETURNING id`, repo, owner, tc.workspaceStatus, tc.link != "session", session, tc.workspaceDeleted).Scan(&workspace))
				if tc.link != "workspace" {
					_, err = tx.Exec(ctx, `UPDATE agent_sessions SET workspace_id=$1 WHERE id=$2`, workspace, session)
					require.NoError(t, err)
				}
			}
			count, err := q.CountActiveAgentSessionVMsForUser(ctx, user)
			require.NoError(t, err)
			require.Equal(t, tc.want, count)
			count, err = q.CountActiveAgentSessionVMsForUser(ctx, other)
			require.NoError(t, err)
			require.Zero(t, count)
		})
	}
}

func TestSandboxUsageIntervalsIdempotentAndOrphanSweep(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	user, repo := mustCreateUserAndRepo(t, tx, "meter-sweep", "meter-sweep-repo")
	var workspace, gateway, agent string
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,status,suspended_at,last_activity_at) VALUES($1,$2,'suspended',now()-interval '10 minutes',now()-interval '20 minutes') RETURNING id`, repo, user).Scan(&workspace))
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO repo_gateways(repository_id,user_id,status,last_activity_at) VALUES($1,$2,'stopped',now()-interval '15 minutes') RETURNING id`, repo, user).Scan(&gateway))
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status,finished_at) VALUES(gen_random_uuid(),$1,$2,'completed',now()-interval '5 minutes') RETURNING id`, repo, user).Scan(&agent))
	for kind, id := range map[string]string{"workspace": workspace, "gateway": gateway, "agent": agent} {
		arg := OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: kind, SandboxID: id}
		require.NoError(t, q.OpenSandboxUsageInterval(ctx, arg))
		require.NoError(t, q.OpenSandboxUsageInterval(ctx, arg))
	}
	_, err := tx.Exec(ctx, `UPDATE sandbox_usage_intervals SET started_at=now()-interval '1 hour' WHERE user_id=$1`, user)
	require.NoError(t, err)
	require.NoError(t, q.OpenSandboxUsageInterval(ctx, OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: "workspace", SandboxID: "missing-text-id"}))
	require.NoError(t, q.CloseOrphanedSandboxUsageIntervals(ctx))
	var count, seconds int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT count(*),sum(extract(epoch from ended_at-started_at))::bigint FROM sandbox_usage_intervals WHERE user_id=$1 AND ended_at IS NOT NULL`, user).Scan(&count, &seconds))
	require.Equal(t, int64(4), count)
	require.Equal(t, int64(3000+2700+3300), seconds)
	require.NoError(t, q.OpenSandboxUsageInterval(ctx, OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: "agent", SandboxID: agent}))
	require.NoError(t, q.CloseSandboxUsageInterval(ctx, CloseSandboxUsageIntervalParams{SandboxKind: "agent", SandboxID: agent}))
	require.NoError(t, q.CloseSandboxUsageInterval(ctx, CloseSandboxUsageIntervalParams{SandboxKind: "agent", SandboxID: agent}))
}

func TestSandboxUsageOrphanSweepPreservesLiveIntervals(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	user, repo := mustCreateUserAndRepo(t, tx, "meter-live", "meter-live-repo")
	for _, status := range []string{"pending", "starting", "running"} {
		var id string
		require.NoError(t, tx.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,status,is_fork,target_bookmark) VALUES($1,$2,$3::text,true,$3::text) RETURNING id`, repo, user, status).Scan(&id))
		require.NoError(t, q.OpenSandboxUsageInterval(ctx, OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: "workspace", SandboxID: id}))
	}
	var gateway, agent string
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO repo_gateways(repository_id,user_id,status,vm_id) VALUES($1,$2,'running','vm-live') RETURNING id`, repo, user).Scan(&gateway))
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status,started_at) VALUES(gen_random_uuid(),$1,$2,'active',now()) RETURNING id`, repo, user).Scan(&agent))
	require.NoError(t, q.OpenSandboxUsageInterval(ctx, OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: "gateway", SandboxID: gateway}))
	require.NoError(t, q.OpenSandboxUsageInterval(ctx, OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: "agent", SandboxID: agent}))
	require.NoError(t, q.CloseOrphanedSandboxUsageIntervals(ctx))
	var count int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM sandbox_usage_intervals WHERE user_id=$1 AND ended_at IS NULL`, user).Scan(&count))
	require.Equal(t, int64(5), count)
}
