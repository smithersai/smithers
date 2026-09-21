package clusterservices

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAdminManagementSQLFilters(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := db.New(tx)
	// Explicit fixture IDs and rollback leave shared integration fixtures and
	// their identity sequences untouched.
	human := time.Now().UnixNano()
	synthetic, repo, synthRepo := human+1, human+2, human+3
	for _, v := range []struct{ user, repo int64 }{{human, repo}, {synthetic, synthRepo}} {
		name := fmt.Sprintf("manage-%d", v.user)
		_, err = tx.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES ($1,$2,$2)`, v.user, name)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `INSERT INTO repositories(id,user_id,name,lower_name,storage_set_id) VALUES ($1,$2,$3,$3,'s1')`, v.repo, v.user, name)
		require.NoError(t, err)
	}
	// Classification is independent of account type: an ordinary user may be
	// synthetic, while a service account explicitly marked non-synthetic is visible.
	_, err = tx.Exec(ctx, `UPDATE users SET user_type='service' WHERE id=$1`, human)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE users SET is_synthetic=true WHERE id=$1`, synthetic)
	require.NoError(t, err)
	var owner string
	require.NoError(t, tx.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, human).Scan(&owner))
	humanID, synthID := uuid.NewString(), uuid.NewString()
	for _, v := range []struct {
		id         string
		user, repo int64
	}{{humanID, human, repo}, {synthID, synthetic, synthRepo}} {
		_, err = tx.Exec(ctx, `INSERT INTO agent_sessions(id,user_id,repository_id,status) VALUES ($1,$2,$3,'active')`, v.id, v.user, v.repo)
		require.NoError(t, err)
	}
	agents, err := q.AdminListAgentSessions(ctx, db.AdminListAgentSessionsParams{Status: "active", RowLimit: 200})
	require.NoError(t, err)
	seenHuman, seenSynthetic := false, false
	for _, row := range agents {
		seenHuman = seenHuman || row.AgentSession.ID == humanID
		seenSynthetic = seenSynthetic || row.AgentSession.ID == synthID
	}
	require.True(t, seenHuman)
	require.False(t, seenSynthetic)
	agents, err = q.AdminListAgentSessions(ctx, db.AdminListAgentSessionsParams{Status: "all", IncludeSynthetic: true, RowLimit: 200})
	require.NoError(t, err)
	seenSynthetic = false
	for _, row := range agents {
		seenSynthetic = seenSynthetic || row.AgentSession.ID == synthID
	}
	require.True(t, seenSynthetic)
	// Model a reserved identity already classified by the analytics backfill.
	var namedSynthetic int64
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO users(id,username,lower_username,is_synthetic) VALUES ($1,'smithers-observer','smithers-observer',true) RETURNING id`, human+4).Scan(&namedSynthetic))
	_, err = tx.Exec(ctx, `UPDATE agent_sessions SET user_id=$1 WHERE id=$2`, namedSynthetic, synthID)
	require.NoError(t, err)
	agents, err = q.AdminListAgentSessions(ctx, db.AdminListAgentSessionsParams{Status: "active", RowLimit: 200})
	require.NoError(t, err)
	for _, row := range agents {
		require.NotEqual(t, synthID, row.AgentSession.ID)
	}
	workspace := uuid.NewString()
	_, err = tx.Exec(ctx, `INSERT INTO workspaces(id,user_id,repository_id,name,kind,status) VALUES ($1,$2,$3,'managed','agent','failed')`, workspace, human, repo)
	require.NoError(t, err)
	rows, err := q.AdminListWorkspaces(ctx, db.AdminListWorkspacesParams{Owner: owner, Kind: "agent", Status: "failed", RowLimit: 200})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, workspace, rows[0].Workspace.ID)
	require.True(t, rows[0].Workspace.FailureCode.Valid)
	rows, err = q.AdminListWorkspaces(ctx, db.AdminListWorkspacesParams{Owner: owner, Kind: "desktop", RowLimit: 200})
	require.NoError(t, err)
	require.Empty(t, rows)
	// Workspace filtering follows the same explicit classification flag.
	_, err = tx.Exec(ctx, `UPDATE users SET is_synthetic=true WHERE id=$1`, human)
	require.NoError(t, err)
	rows, err = q.AdminListWorkspaces(ctx, db.AdminListWorkspacesParams{Owner: owner, RowLimit: 200})
	require.NoError(t, err)
	require.Empty(t, rows)
	rows, err = q.AdminListWorkspaces(ctx, db.AdminListWorkspacesParams{Owner: owner, IncludeSynthetic: true, RowLimit: 200})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, workspace, rows[0].Workspace.ID)
	// Token age falls back to creation for never-used tokens, and scope matching
	// must not match a prefix or suffix of another scope.
	scope := "scope-" + uuid.NewString()
	now := time.Now().UTC()
	for _, v := range []struct {
		name, scopes     string
		created, expires time.Time
	}{
		{"old-unused", scope + ",read:user", now.Add(-60 * 24 * time.Hour), now.Add(24 * time.Hour)},
		{"new-unused", scope, now, now.Add(24 * time.Hour)},
		{"expired", scope, now.Add(-60 * 24 * time.Hour), now.Add(-time.Hour)},
		{"wrong-scope", scope + "-extra", now.Add(-60 * 24 * time.Hour), now.Add(24 * time.Hour)},
	} {
		_, err = tx.Exec(ctx, `INSERT INTO access_tokens(user_id,name,scopes,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, human, v.name, v.scopes, uuid.NewString(), v.created, v.expires)
		require.NoError(t, err)
	}
	tokens, err := q.AdminListTokens(ctx, db.AdminListTokensParams{UnusedDays: 30, ExpiringDays: 7, Scope: scope, RowLimit: 500})
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.Equal(t, "old-unused", tokens[0].Name)
}

func TestAdminStopWorkspaceRetainsRowAndEndsSessions(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	q := db.New(tx)
	user, repo := time.Now().UnixNano(), time.Now().UnixNano()+1
	owner := fmt.Sprintf("stop-owner-%d", user)
	_, err = tx.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES ($1,$2,$2)`, user, owner)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO repositories(id,user_id,name,lower_name,storage_set_id) VALUES ($1,$2,'stop-repo','stop-repo','s1')`, repo, user)
	require.NoError(t, err)
	var tokenID int64
	require.NoError(t, tx.QueryRow(ctx, `INSERT INTO access_tokens(user_id,name,scopes,token_hash) VALUES ($1,'head','write:repository',$2) RETURNING id`, user, uuid.NewString()).Scan(&tokenID))
	id := uuid.NewString()
	_, err = tx.Exec(ctx, `INSERT INTO workspaces(id,user_id,repository_id,name,kind,status,vm_id,head_push_token_id) VALUES ($1,$2,$3,'stop-test','container','running','stop-vm',$4)`, id, user, repo, tokenID)
	require.NoError(t, err)
	for _, status := range []string{"pending", "starting", "running", "failed"} {
		_, err = tx.Exec(ctx, `INSERT INTO workspace_sessions(workspace_id,user_id,repository_id,status) VALUES ($1,$2,$3,$4)`, id, user, repo, status)
		require.NoError(t, err)
	}
	deleted := 0
	var gauge float64
	lifecycle := newWorkspaceServiceForTests(q, services.WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{deleteVMFn: func(_ context.Context, vm string) error {
		require.Equal(t, "stop-vm", vm)
		// The real lifecycle cannot reach teardown until the intent is persisted.
		var outcome string
		require.NoError(t, tx.QueryRow(ctx, `SELECT metadata->>'outcome' FROM audit_log WHERE target_name=$1`, id).Scan(&outcome))
		require.Equal(t, "attempted", outcome)
		deleted++
		return nil
	}}), services.WithWorkspaceSandboxMetrics(&mockSandboxMetricsRecorder{addActiveVMsFn: func(_ string, delta float64) { gauge += delta }}))
	_, err = lifecycle.StopWorkspace(ctx, id, repo, user+1)
	require.Error(t, err)
	require.Zero(t, deleted)
	admin := NewAdminManageService(q, nil, lifecycle, nil)
	ctx = services.ContextWithAdminAuditActor(ctx, services.AdminAuditActor{UserID: user, Username: owner})
	result, err := admin.StopWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "stopped", result.Status)
	require.Equal(t, 1, deleted)
	require.Equal(t, float64(-1), gauge)
	row, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.False(t, row.DeletedAt.Valid)
	require.False(t, row.HeadPushTokenID.Valid)
	require.Equal(t, result.Status, row.Status)
	visible, err := lifecycle.GetWorkspace(ctx, id, repo, user)
	require.NoError(t, err)
	require.Equal(t, "stopped", visible.Status)
	rows, err := admin.ListWorkspaces(ctx, db.AdminListWorkspacesParams{Owner: owner})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, id, rows[0].ID)
	var active, stopped, failed, tokens int
	require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status IN ('pending','starting','running')), count(*) FILTER(WHERE status='stopped'), count(*) FILTER(WHERE status='failed') FROM workspace_sessions WHERE workspace_id=$1`, id).Scan(&active, &stopped, &failed))
	require.Zero(t, active)
	require.Equal(t, 3, stopped)
	require.Equal(t, 1, failed)
	require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE id=$1`, tokenID).Scan(&tokens))
	require.Zero(t, tokens)
	var outcomes []string
	auditRows, err := tx.Query(ctx, `SELECT metadata->>'outcome' FROM audit_log WHERE event_type='admin.workspace.stop' AND target_name=$1 AND actor_id=$2 ORDER BY id`, id, user)
	require.NoError(t, err)
	for auditRows.Next() {
		var outcome string
		require.NoError(t, auditRows.Scan(&outcome))
		outcomes = append(outcomes, outcome)
	}
	require.NoError(t, auditRows.Err())
	auditRows.Close()
	require.Equal(t, []string{"attempted", "succeeded"}, outcomes)
	_, err = admin.StopWorkspace(ctx, id)
	require.Error(t, err)
	require.Equal(t, 1, deleted)
}
