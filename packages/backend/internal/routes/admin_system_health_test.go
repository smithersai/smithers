package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockSystemHealthChecker struct {
	pingFn func(ctx context.Context) error
}

func (m *mockSystemHealthChecker) Ping(ctx context.Context) error {
	if m.pingFn != nil {
		return m.pingFn(ctx)
	}
	return nil
}

func TestAdminSystemHealthHandler_SystemHealth(t *testing.T) {
	t.Parallel()

	t.Run("returns 200 and ok status when database is healthy", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemHealthHandler{
			DB: &mockSystemHealthChecker{
				pingFn: func(ctx context.Context) error {
					return nil
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/system/health", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.SystemHealth(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var body systemHealthResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "ok", body.Status)
		assert.Equal(t, "ok", body.Database.Status)
		assert.NotEmpty(t, body.Database.Latency)
	})

	t.Run("returns 503 and degraded status when database is down", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemHealthHandler{
			DB: &mockSystemHealthChecker{
				pingFn: func(ctx context.Context) error {
					return errors.New("connection refused")
				},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/system/health", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.SystemHealth(rec, req)

		require.Equal(t, http.StatusServiceUnavailable, rec.Code)

		var body systemHealthResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "degraded", body.Status)
		assert.Equal(t, "error", body.Database.Status)
		assert.Contains(t, body.Database.Error, "connection refused")
	})

	t.Run("response has database component", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemHealthHandler{
			DB: &mockSystemHealthChecker{},
		}

		req := httptest.NewRequest(http.MethodGet, "/api/admin/system/health", nil)
		req = withAdminContext(req)
		rec := httptest.NewRecorder()
		h.SystemHealth(rec, req)

		var payload map[string]interface{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Contains(t, payload, "status")
		assert.Contains(t, payload, "database")
	})
}
