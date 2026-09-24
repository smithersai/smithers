package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestApprovals_H_ListAndGetRemainingBranches(t *testing.T) {
	t.Run("list invalid pagination", func(t *testing.T) {
		handler := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/approvals?page=0", nil)
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		handler.ListApprovals(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list service error", func(t *testing.T) {
		handler := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{
			listFn: func(context.Context, int64, string, int, int) ([]services.ApprovalResponse, error) {
				return nil, pkgerrors.Internal("approvals unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/approvals?state=pending", nil)
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		handler.ListApprovals(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("get disabled nil and missing context", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/approvals/a", nil)
		req = withRouteParams(req, map[string]string{"id": "a"})
		rec := httptest.NewRecorder()
		(&ApprovalsHandler{}).GetApproval(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)

		rec = httptest.NewRecorder()
		(&ApprovalsHandler{Enabled: true}).GetApproval(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		rec = httptest.NewRecorder()
		(&ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}).GetApproval(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestApprovals_H_DecideRemainingBranches(t *testing.T) {
	t.Run("nil service", func(t *testing.T) {
		handler := &ApprovalsHandler{Enabled: true}
		req := httptest.NewRequest(http.MethodPost, "/approvals/a/decide", strings.NewReader(`{"decision":"approved"}`))
		req = withRouteParams(req, map[string]string{"id": "a"})
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		handler.Decide(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("missing approval id", func(t *testing.T) {
		handler := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/approvals/decide", strings.NewReader(`{"decision":"approved"}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		handler.Decide(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
