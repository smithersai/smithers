package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestIssues_F_GuardBranches exercises every remaining error-guard branch in
// issues.go: missing-auth, missing repo owner/name, and missing/invalid numeric
// route params across the comment handlers.
func TestIssues_F_GuardBranches(t *testing.T) {
	ownerRepo := map[string]string{"owner": "alice", "repo": "demo"}

	t.Run("CreateIssue missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos//issues", strings.NewReader(`{"title":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("GetIssue missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//issues/1", nil)
		rec := httptest.NewRecorder()
		h.GetIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PatchIssue missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos//issues/1", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PatchIssue missing number param", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PostIssueComment missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos//issues/1/comments", strings.NewReader(`{"body":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListIssueComments missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//issues/1/comments", nil)
		rec := httptest.NewRecorder()
		h.ListIssueComments(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListIssueComments missing number param", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues//comments", nil)
		req = withRouteParams(req, ownerRepo)
		rec := httptest.NewRecorder()
		h.ListIssueComments(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("GetIssueComment missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//issues/comments/1", nil)
		rec := httptest.NewRecorder()
		h.GetIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PatchIssueComment requires auth", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/comments/1", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.PatchIssueComment(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("PatchIssueComment missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos//issues/comments/1", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PatchIssueComment missing id param", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/comments/", strings.NewReader(`{}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteIssueComment requires auth", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/comments/1", nil)
		rec := httptest.NewRecorder()
		h.DeleteIssueComment(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("DeleteIssueComment missing repo params", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos//issues/comments/1", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteIssueComment missing id param", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/comments/", nil)
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
