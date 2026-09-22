package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

type fakeSandboxEgressAuditQuerier struct {
	params clusterdb.ListSandboxEgressAuditByResourceParams
	rows   []clusterdb.SandboxEgressAudit
}

func (f *fakeSandboxEgressAuditQuerier) ListSandboxEgressAuditByResource(_ context.Context, params clusterdb.ListSandboxEgressAuditByResourceParams) ([]clusterdb.SandboxEgressAudit, error) {
	f.params = params
	return f.rows, nil
}

func TestSandboxEgressAuditServiceKeysetPagination(t *testing.T) {
	now := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	querier := &fakeSandboxEgressAuditQuerier{rows: []clusterdb.SandboxEgressAudit{
		{ID: 3, OccurredAt: now, Host: "one.example", Method: "GET", Path: "/one", Status: 200, Allowed: true, SwappedSecretNames: []string{}},
		{ID: 2, OccurredAt: now.Add(-time.Second), Host: "two.example", Method: "POST", Path: "/two", Status: 403, Allowed: false, SwappedSecretNames: []string{"TOKEN"}},
		{ID: 1, OccurredAt: now.Add(-2 * time.Second), Host: "three.example"},
	}}
	service := NewSandboxEgressAuditService(querier)
	result, err := service.List(context.Background(), "agent_session", "session-one", 42, "", 2)
	require.NoError(t, err)
	require.Len(t, result.Items, 2)
	assert.NotEmpty(t, result.NextCursor)
	assert.Equal(t, int32(3), querier.params.PageSize)
	assert.Equal(t, int64(42), querier.params.RepositoryID.Int64)

	position, err := decodeSandboxEgressCursor(result.NextCursor)
	require.NoError(t, err)
	assert.Equal(t, int64(2), position.ID)
	assert.Equal(t, now.Add(-time.Second), position.OccurredAt)

	_, err = service.List(context.Background(), "workspace", "workspace-one", 42, result.NextCursor, 2)
	require.NoError(t, err)
	assert.True(t, querier.params.HasCursor)
	assert.Equal(t, int64(2), querier.params.CursorID)
}

func TestSandboxEgressAuditServiceRejectsMalformedCursor(t *testing.T) {
	_, err := NewSandboxEgressAuditService(&fakeSandboxEgressAuditQuerier{}).List(
		context.Background(), "workspace", "workspace-one", 42, "not-base64!", 30,
	)
	require.Error(t, err)
}
