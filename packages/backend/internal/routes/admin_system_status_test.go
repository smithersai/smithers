package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type stubAdminSystemStatus struct {
	status      services.AdminSystemStatus
	hadDeadline bool
}

func (s *stubAdminSystemStatus) SystemStatus(ctx context.Context) services.AdminSystemStatus {
	_, s.hadDeadline = ctx.Deadline()
	return s.status
}

func TestAdminSystemStatusHandlerReturnsSnapshot(t *testing.T) {
	for _, verdict := range []string{"ok", "degraded"} {
		t.Run(verdict, func(t *testing.T) {
			stub := &stubAdminSystemStatus{status: services.AdminSystemStatus{
				Status:        verdict,
				Database:      services.AdminSystemStatusDatabase{Status: "ok", LatencyMS: 1.25},
				Queues:        services.AdminSystemStatusQueues{Landing: services.AdminSystemStatusLandingQueue{Depth: 9}},
				Connections:   services.AdminSystemStatusConnections{SSE: 42},
				AgentSessions: services.AdminSystemStatusAgentSessions{Active: 3, OldestAgeSeconds: 120.5},
			}}
			rec := httptest.NewRecorder()
			(&AdminSystemStatusHandler{Service: stub}).SystemStatus(rec, httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))

			require.Equal(t, http.StatusOK, rec.Code)
			assert.True(t, stub.hadDeadline)
			var body services.AdminSystemStatus
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, stub.status, body)
		})
	}
}

func TestAdminSystemStatusHandlerWithoutServiceFails(t *testing.T) {
	rec := httptest.NewRecorder()
	(&AdminSystemStatusHandler{}).SystemStatus(rec, httptest.NewRequest(http.MethodGet, "/api/admin/system/status", nil))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}
