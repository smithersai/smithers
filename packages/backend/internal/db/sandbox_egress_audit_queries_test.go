package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSandboxEgressAuditBatchListCursorAndRetention(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sessionID := "15e9e9fc-e6f2-46d7-a359-e55fe55eecc8"
	workspaceID := "612a1996-68e3-4762-860f-61def4052c17"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Status: "active",
	})
	require.NoError(t, err)
	mustExec(t, pool, `
		INSERT INTO workspaces (id, repository_id, user_id, name, status)
		VALUES ($1, $2, $3, 'audit-workspace', 'running')`, workspaceID, repoID, userID)
	mustExec(t, pool, `
		INSERT INTO sandbox_hosts (
			id, identity_public_key, identity_signed_at, base_url,
			capacity_cpu_millis, capacity_memory_bytes, capacity_disk_bytes, capacity_vms, lease_expires_at
		) VALUES (
			'worker-egress', decode(repeat('00', 32), 'hex'), NOW(), 'https://worker-egress.internal',
			1000, 1048576, 1048576, 1, NOW() + INTERVAL '1 hour'
		)`)
	mustExec(t, pool, `
		INSERT INTO sandbox_instances (id, provider, provider_local_id, worker_id, resource_kind, resource_id)
		VALUES
			('msb-egress', 'microsandbox', 'msb-egress', 'worker-egress', 'agent_session', $1),
			('msb-workspace-egress', 'microsandbox', 'msb-workspace-egress', 'worker-egress', 'workspace', $2)`, sessionID, workspaceID)

	now := time.Now().UTC().Truncate(time.Microsecond)
	records := []map[string]any{
		{"sandbox_id": "msb-egress", "occurred_at": now, "host": "api.cerebras.ai", "method": "POST", "path": "/v1/chat", "status": 200, "allowed": true, "swapped_secret_names": []string{"CEREBRAS_API_KEY"}, "transform_summary": map[string]any{"swapped_secret_count": 1}},
		{"sandbox_id": "msb-egress", "occurred_at": now.Add(-40 * 24 * time.Hour), "host": "example.com", "method": "GET", "path": "/old", "status": 403, "allowed": false, "swapped_secret_names": []string{}, "transform_summary": map[string]any{}},
		{"sandbox_id": "msb-workspace-egress", "occurred_at": now.Add(-time.Second), "host": "workspace.example", "method": "GET", "path": "/workspace", "status": 200, "allowed": true, "swapped_secret_names": []string{}, "transform_summary": map[string]any{}},
	}
	payload, err := json.Marshal(records)
	require.NoError(t, err)
	inserted, err := q.InsertSandboxEgressAuditBatch(ctx, InsertSandboxEgressAuditBatchParams{WorkerID: "worker-egress", Records: payload})
	require.NoError(t, err)
	assert.Equal(t, int64(3), inserted)

	first, err := q.ListSandboxEgressAuditByResource(ctx, ListSandboxEgressAuditByResourceParams{
		ResourceKind: "agent_session", ResourceID: sessionID,
		RepositoryID: pgtype.Int8{Int64: repoID, Valid: true}, PageSize: 1,
	})
	require.NoError(t, err)
	require.Len(t, first, 1)
	assert.Equal(t, repoID, first[0].RepositoryID.Int64)
	assert.Equal(t, []string{"CEREBRAS_API_KEY"}, first[0].SwappedSecretNames)

	second, err := q.ListSandboxEgressAuditByResource(ctx, ListSandboxEgressAuditByResourceParams{
		ResourceKind: "agent_session", ResourceID: sessionID,
		RepositoryID: pgtype.Int8{Int64: repoID, Valid: true}, HasCursor: true,
		CursorOccurredAt: first[0].OccurredAt, CursorID: first[0].ID, PageSize: 10,
	})
	require.NoError(t, err)
	require.Len(t, second, 1)
	assert.Equal(t, "/old", second[0].Path)

	workspaceRows, err := q.ListSandboxEgressAuditByResource(ctx, ListSandboxEgressAuditByResourceParams{
		ResourceKind: "workspace", ResourceID: workspaceID,
		RepositoryID: pgtype.Int8{Int64: repoID, Valid: true}, PageSize: 10,
	})
	require.NoError(t, err)
	require.Len(t, workspaceRows, 1)
	assert.Equal(t, "workspace.example", workspaceRows[0].Host)
	assert.Equal(t, repoID, workspaceRows[0].RepositoryID.Int64)

	deleted, err := q.DeleteSandboxEgressAuditOlderThan(ctx, 30)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
}
