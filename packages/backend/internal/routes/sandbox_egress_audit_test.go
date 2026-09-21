package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeSandboxEgressAuditRouteService struct {
	kind, id, cursor string
	repositoryID     int64
	limit            int
	result           services.SandboxEgressAuditList
}

func (f *fakeSandboxEgressAuditRouteService) List(_ context.Context, kind, id string, repositoryID int64, cursor string, limit int) (services.SandboxEgressAuditList, error) {
	f.kind, f.id, f.repositoryID, f.cursor, f.limit = kind, id, repositoryID, cursor, limit
	return f.result, nil
}

func TestAgentSessionEgressAuditRouteReturnsDTOAndCursor(t *testing.T) {
	audit := &fakeSandboxEgressAuditRouteService{result: services.SandboxEgressAuditList{
		Items: []services.SandboxEgressAuditEntry{{
			OccurredAt: time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC), Host: "api.cerebras.ai",
			Method: "POST", Path: "/v1/chat", Status: 200, Allowed: true,
			SwappedSecretNames: []string{"CEREBRAS_API_KEY"},
		}},
		NextCursor: "next-token",
	}}
	handler := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}, EgressAudit: audit}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent-sessions/session-one/egress?cursor=current&limit=7", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "alice", "demo")
	req = withChiParams(req, map[string]string{"id": "session-one"})
	rec := httptest.NewRecorder()
	handler.ListEgressAudit(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "agent_session", audit.kind)
	assert.Equal(t, "session-one", audit.id)
	assert.Equal(t, int64(101), audit.repositoryID)
	assert.Equal(t, "current", audit.cursor)
	assert.Equal(t, 7, audit.limit)
	assert.Contains(t, rec.Header().Get("Link"), "cursor=next-token")
	var body []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "api.cerebras.ai", body[0]["host"])
	assert.NotContains(t, body[0], "sandbox_id")
	assert.NotContains(t, body[0], "transform_summary")
}

func TestWorkspaceEgressAuditRouteChecksWorkspaceAndPaginates(t *testing.T) {
	var checked bool
	audit := &fakeSandboxEgressAuditRouteService{result: services.SandboxEgressAuditList{Items: []services.SandboxEgressAuditEntry{}, NextCursor: "next-workspace"}}
	handler := &WorkspaceHandler{
		Service: &mockWorkspaceRouteService{getWorkspaceFn: func(_ context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error) {
			checked = true
			assert.Equal(t, "workspace-one", workspaceID)
			assert.Equal(t, int64(200), repositoryID)
			assert.Equal(t, int64(7), userID)
			return services.WorkspaceResponse{ID: workspaceID}, nil
		}},
		EgressAudit: audit,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/workspace-one/egress?limit=3", nil)
	req = withAuth(req, 7, "alice")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withChiParams(req, map[string]string{"id": "workspace-one"})
	rec := httptest.NewRecorder()
	handler.ListEgressAudit(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, checked)
	assert.Equal(t, "workspace", audit.kind)
	assert.Equal(t, int64(200), audit.repositoryID)
	assert.Equal(t, 3, audit.limit)
	assert.Contains(t, rec.Header().Get("Link"), "cursor=next-workspace")
	assert.JSONEq(t, `[]`, rec.Body.String())
}
