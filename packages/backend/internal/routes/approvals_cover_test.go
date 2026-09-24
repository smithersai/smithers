package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestApprovals_Cov_ListAndGetErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("list service nil", func(t *testing.T) {
		t.Parallel()

		h := &ApprovalsHandler{Enabled: true}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.ListApprovals(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "approvals service unavailable")
	})

	t.Run("list missing repo context", func(t *testing.T) {
		t.Parallel()

		h := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals", nil)
		rec := httptest.NewRecorder()

		h.ListApprovals(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get missing id", func(t *testing.T) {
		t.Parallel()

		h := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals/", nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.GetApproval(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "approval id required")
	})

	t.Run("get service error", func(t *testing.T) {
		t.Parallel()

		h := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{
			getFn: func(context.Context, string, int64) (services.ApprovalResponse, error) {
				return services.ApprovalResponse{}, pkgerrors.NotFound("approval not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/approvals/ap-1", nil)
		req = withRouteParams(req, map[string]string{"id": "ap-1"})
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.GetApproval(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestApprovals_Cov_DecideAliasAndLargeBody(t *testing.T) {
	t.Parallel()

	t.Run("alias delegates", func(t *testing.T) {
		t.Parallel()

		var called bool
		h := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{
			decideFn: func(_ context.Context, input services.DecideApprovalInput) (services.ApprovalResponse, error) {
				called = true
				assert.Equal(t, "approval-1", input.ApprovalID)
				assert.Equal(t, int64(7), input.UserID)
				return services.ApprovalResponse{ID: input.ApprovalID, State: input.Decision}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/approval-1/decide", strings.NewReader(`{"decision":"rejected"}`))
		req = withRouteParams(req, map[string]string{"id": "approval-1"})
		req = withAuth(req, 7, "alice")
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.DecideApproval(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)
	})

	t.Run("body over limit", func(t *testing.T) {
		t.Parallel()

		h := &ApprovalsHandler{Enabled: true, Service: &mockApprovalRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/approvals/approval-1/decide", strings.NewReader(`{"decision":"approved","padding":"`+strings.Repeat("x", 2048)+`"}`))
		req = withRouteParams(req, map[string]string{"id": "approval-1"})
		req = withAuth(req, 7, "alice")
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		h.Decide(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
