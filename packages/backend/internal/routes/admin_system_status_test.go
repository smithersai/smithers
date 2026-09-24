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

	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
)

type stubAdminSystemStatusService struct {
	status      clusterservices.AdminSystemStatus
	calls       int
	hadDeadline bool
}

func (s *stubAdminSystemStatusService) SystemStatus(ctx context.Context) clusterservices.AdminSystemStatus {
	s.calls++
	_, ok := ctx.Deadline()
	s.hadDeadline = ok
	return s.status
}

func healthyAdminSystemStatus() clusterservices.AdminSystemStatus {
	return clusterservices.AdminSystemStatus{
		Status:      "ok",
		GeneratedAt: time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC),
		Database:    clusterservices.AdminSystemStatusDatabase{Status: "ok", LatencyMS: 1.25},
		RunnerPool:  clusterservices.AdminSystemStatusRunnerPool{Available: 4, Claimed: 2},
		Queues: clusterservices.AdminSystemStatusQueues{
			WorkflowTasks: clusterservices.AdminSystemStatusWorkflowTaskQueue{Depth: 7, OldestAgeSeconds: 31.25},
			Landing:       clusterservices.AdminSystemStatusLandingQueue{Depth: 9},
		},
		Connections:   clusterservices.AdminSystemStatusConnections{SSE: 42},
		AgentSessions: clusterservices.AdminSystemStatusAgentSessions{Active: 3, OldestAgeSeconds: 120.5},
		Sandboxes:     clusterservices.AdminSystemStatusSandboxes{ActiveVMs: 7},
		Canaries:      clusterservices.AdminSystemStatusCanaries{Passing: 29, Failing: 1, Stale: 2},
		Incidents:     clusterservices.AdminSystemStatusIncidents{Open: 1, Remediating: 2, Acknowledged: 3, Snoozed: 4},
	}
}

func TestAdminSystemStatusHandler_SystemStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		status   clusterservices.AdminSystemStatus
		wantCode int
		verify   func(t *testing.T, body clusterservices.AdminSystemStatus)
	}{
		{
			name:     "healthy snapshot returns 200 and ok",
			status:   healthyAdminSystemStatus(),
			wantCode: http.StatusOK,
			verify: func(t *testing.T, body clusterservices.AdminSystemStatus) {
				assert.Equal(t, "ok", body.Status)
				assert.Equal(t, "ok", body.Database.Status)
				assert.InDelta(t, 1.25, body.Database.LatencyMS, 0.0001)
				assert.Equal(t, 4, body.RunnerPool.Available)
				assert.Equal(t, 2, body.RunnerPool.Claimed)
				assert.Equal(t, 7, body.Queues.WorkflowTasks.Depth)
				assert.Equal(t, 9, body.Queues.Landing.Depth)
				assert.Equal(t, 42, body.Connections.SSE)
				assert.Equal(t, 3, body.AgentSessions.Active)
				assert.Equal(t, 7, body.Sandboxes.ActiveVMs)
				assert.Equal(t, 29, body.Canaries.Passing)
				assert.Equal(t, 1, body.Incidents.Open)
				assert.Equal(t, 3, body.Incidents.Acknowledged)
				assert.Equal(t, 4, body.Incidents.Snoozed)
				assert.Empty(t, body.Errors)
			},
		},
		{
			name: "degraded snapshot still returns 200",
			status: func() clusterservices.AdminSystemStatus {
				status := healthyAdminSystemStatus()
				status.Status = "degraded"
				status.Database = clusterservices.AdminSystemStatusDatabase{Status: "error", Error: "connection refused"}
				return status
			}(),
			wantCode: http.StatusOK,
			verify: func(t *testing.T, body clusterservices.AdminSystemStatus) {
				assert.Equal(t, "degraded", body.Status)
				assert.Equal(t, "error", body.Database.Status)
				assert.Contains(t, body.Database.Error, "connection refused")
			},
		},
		{
			name: "component errors are surfaced without failing the request",
			status: func() clusterservices.AdminSystemStatus {
				status := healthyAdminSystemStatus()
				status.RunnerPool = clusterservices.AdminSystemStatusRunnerPool{}
				status.Errors = []string{"runner_pool: runner query failed"}
				return status
			}(),
			wantCode: http.StatusOK,
			verify: func(t *testing.T, body clusterservices.AdminSystemStatus) {
				assert.Equal(t, "ok", body.Status)
				assert.Equal(t, clusterservices.AdminSystemStatusRunnerPool{}, body.RunnerPool)
				require.Len(t, body.Errors, 1)
				assert.Equal(t, "runner_pool: runner query failed", body.Errors[0])
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			svc := &stubAdminSystemStatusService{status: tt.status}
			h := &AdminSystemStatusHandler{Service: svc}

			req := withAdminContext(httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))
			rec := httptest.NewRecorder()
			h.SystemStatus(rec, req)

			require.Equal(t, tt.wantCode, rec.Code)
			assert.Equal(t, 1, svc.calls)
			assert.True(t, svc.hadDeadline, "handler must bound the aggregation with a timeout")

			var body clusterservices.AdminSystemStatus
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			tt.verify(t, body)
		})
	}

	t.Run("response carries the documented JSON keys", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemStatusHandler{Service: &stubAdminSystemStatusService{status: healthyAdminSystemStatus()}}

		req := withAdminContext(httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))
		rec := httptest.NewRecorder()
		h.SystemStatus(rec, req)

		var payload map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		for _, key := range []string{
			"status", "generated_at", "database", "runner_pool", "queues",
			"connections", "agent_sessions", "sandboxes", "canaries", "incidents",
		} {
			assert.Contains(t, payload, key)
		}
		assert.NotContains(t, payload, "errors")

		assert.Equal(t, "2026-08-15T12:00:00Z", payload["generated_at"])

		database, ok := payload["database"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, database, "status")
		assert.Contains(t, database, "latency_ms")
		assert.NotContains(t, database, "error")

		queues, ok := payload["queues"].(map[string]interface{})
		require.True(t, ok)
		workflowTasks, ok := queues["workflow_tasks"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, workflowTasks, "depth")
		assert.Contains(t, workflowTasks, "oldest_age_seconds")
		landing, ok := queues["landing"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, landing, "depth")

		connections, ok := payload["connections"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, connections, "sse")

		sessions, ok := payload["agent_sessions"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, sessions, "active")
		assert.Contains(t, sessions, "oldest_age_seconds")

		sandboxes, ok := payload["sandboxes"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, sandboxes, "active_vms")

		canaries, ok := payload["canaries"].(map[string]interface{})
		require.True(t, ok)
		for _, key := range []string{"passing", "failing", "stale"} {
			assert.Contains(t, canaries, key)
		}

		incidents, ok := payload["incidents"].(map[string]interface{})
		require.True(t, ok)
		assert.Contains(t, incidents, "open")
		assert.Contains(t, incidents, "remediating")
	})

	t.Run("returns 500 when the service is not wired", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemStatusHandler{}

		req := withAdminContext(httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))
		rec := httptest.NewRecorder()
		h.SystemStatus(rec, req)

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
