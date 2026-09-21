package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockAuditLogQuerier struct {
	listAuditLogsFn         func(ctx context.Context, arg db.ListAuditLogsParams) ([]db.AuditLog, error)
	listAuditLogsFilteredFn func(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error)
}

func (m *mockAuditLogQuerier) ListAuditLogs(ctx context.Context, arg db.ListAuditLogsParams) ([]db.AuditLog, error) {
	if m.listAuditLogsFn != nil {
		return m.listAuditLogsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockAuditLogQuerier) ListAuditLogsFiltered(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
	if m.listAuditLogsFilteredFn != nil {
		return m.listAuditLogsFilteredFn(ctx, arg)
	}
	return nil, nil
}

func TestAdminAuditHandler_ListAuditLogs_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
		listAuditLogsFilteredFn: func(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
			assert.Equal(t, int32(50), arg.PageLimit)
			// No filters supplied: all wildcard sentinels.
			assert.Equal(t, "", arg.EventType)
			assert.Equal(t, "", arg.TargetType)
			assert.Equal(t, "", arg.TargetName)
			assert.Equal(t, int64(0), arg.ActorID)
			return []db.AuditLog{
				{ID: 1, EventType: "repo.create", ActorName: "alice", Action: "create", CreatedAt: now},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-01", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var logs []db.AuditLog
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &logs))
	assert.Len(t, logs, 1)
}

func TestAdminAuditHandler_ListAuditLogs_MissingSince(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
	req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAdminAuditHandler_ListAuditLogs_InvalidSince(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
	req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=not-a-date", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAdminAuditHandler_ListAuditLogs_RFC3339Since(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
		listAuditLogsFilteredFn: func(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
			assert.Equal(t, 2024, arg.Since.Year())
			assert.Equal(t, time.March, arg.Since.Month())
			return nil, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-03-15T10:30:00Z", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestAdminAuditHandler_ListAuditLogs_DateOnlySince(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
		listAuditLogsFilteredFn: func(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
			assert.Equal(t, 2024, arg.Since.Year())
			assert.Equal(t, time.January, arg.Since.Month())
			assert.Equal(t, 15, arg.Since.Day())
			return nil, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/audit-logs?since=2024-01-15", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

// -----------------------------------------------------------------------------
// Ticket 0134: filtered audit-log retrieval
// -----------------------------------------------------------------------------

// TestAdminAuditHandler_FilterByApprovalTarget asserts the handler
// threads event_type + target_type + target_id into the filtered DB
// query so an operator can pull the full audit trail for one approval
// UUID without paging through unrelated rows.
func TestAdminAuditHandler_FilterByApprovalTarget(t *testing.T) {
	t.Parallel()

	approvalID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	var captured db.ListAuditLogsFilteredParams
	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
		listAuditLogsFilteredFn: func(_ context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
			captured = arg
			return []db.AuditLog{
				{ID: 1, EventType: "approval.requested", TargetType: "approval", TargetName: approvalID, Action: "request"},
				{ID: 2, EventType: "approval.approved", TargetType: "approval", TargetName: approvalID, Action: "approve"},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/audit-logs?since=2024-01-01&target_type=approval&target_id="+approvalID, nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "approval", captured.TargetType)
	assert.Equal(t, approvalID, captured.TargetName)
	assert.Equal(t, "", captured.EventType)

	var logs []db.AuditLog
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &logs))
	assert.Len(t, logs, 2)
	for _, l := range logs {
		assert.Equal(t, "approval", l.TargetType)
		assert.Equal(t, approvalID, l.TargetName)
	}
}

// TestAdminAuditHandler_FilterByEventType_AndActor covers the second
// retrieval shape: "show me every approval.approved event by user 7."
func TestAdminAuditHandler_FilterByEventType_AndActor(t *testing.T) {
	t.Parallel()

	var captured db.ListAuditLogsFilteredParams
	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{
		listAuditLogsFilteredFn: func(_ context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error) {
			captured = arg
			return nil, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/audit-logs?since=2024-01-01&event_type=approval.approved&actor_id=7", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "approval.approved", captured.EventType)
	assert.Equal(t, int64(7), captured.ActorID)
}

// TestAdminAuditHandler_RejectsBadActorID asserts we 400 on a non-integer
// actor_id rather than silently ignoring it (which would blow up a
// reviewer's filter logic).
func TestAdminAuditHandler_RejectsBadActorID(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/audit-logs?since=2024-01-01&actor_id=abc", nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// TestAdminAuditHandler_RejectsTooLongFilters exercises the VARCHAR
// length caps the schema enforces; it's cheaper to 400 at the edge than
// to run a filter that can't match anything.
func TestAdminAuditHandler_RejectsTooLongFilters(t *testing.T) {
	t.Parallel()

	h := &AdminAuditHandler{Queries: &mockAuditLogQuerier{}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/audit-logs?since=2024-01-01&event_type="+strings.Repeat("x", 65), nil)
	rec := httptest.NewRecorder()
	h.ListAuditLogs(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}
