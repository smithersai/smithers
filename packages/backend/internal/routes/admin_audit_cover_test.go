package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAdminAudit_Cov_ValidationAndQueryErrors(t *testing.T) {
	t.Parallel()

	t.Run("rejects invalid pagination", func(t *testing.T) {
		h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01&page=0", nil)
		rec := httptest.NewRecorder()

		h.ListAuditLogs(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid page value")
	})

	t.Run("rejects too long target type", func(t *testing.T) {
		h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01&target_type="+strings.Repeat("x", 65), nil)
		rec := httptest.NewRecorder()

		h.ListAuditLogs(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "target_type too long")
	})

	t.Run("rejects too long target id", func(t *testing.T) {
		h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01&target_id="+strings.Repeat("x", 256), nil)
		rec := httptest.NewRecorder()

		h.ListAuditLogs(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "target_id too long")
	})

	t.Run("rejects negative actor id", func(t *testing.T) {
		h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01&actor_id=-1", nil)
		rec := httptest.NewRecorder()

		h.ListAuditLogs(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "actor_id must be a non-negative integer")
	})

	t.Run("query api error is propagated", func(t *testing.T) {
		h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
			listAuditLogsFilteredFn: func(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
				assert.Equal(t, int32(50), arg.PageLimit)
				return nil, pkgerrors.Forbidden("admin required")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01", nil)
		rec := httptest.NewRecorder()

		h.ListAuditLogs(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "admin required")
	})
}
