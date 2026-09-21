package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestIssues_Cov_MilestonePatchUnmarshal(t *testing.T) {
	var req patchIssueRequest
	require.NoError(t, json.Unmarshal([]byte(`{"milestone":0}`), &req))
	require.True(t, req.Milestone.Set)
	require.NotNil(t, req.Milestone.Value)
	assert.Equal(t, int64(0), *req.Milestone.Value)

	require.Error(t, json.Unmarshal([]byte(`{"milestone":"bad"}`), &req))
}

func TestIssues_Cov_ListCreateGetPatchBranches(t *testing.T) {
	t.Run("list validates route params and pagination", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues", nil)
		rec := httptest.NewRecorder()
		h.ListIssues(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues?page=bad", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		h.ListIssues(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list service error propagates", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			listIssuesFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
				assert.Equal(t, "closed", state)
				return nil, "", 0, pkgerrors.Forbidden("cannot list issues")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues?state=%20closed%20", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListIssues(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("create forwards empty optional fields and service errors", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateIssueInput) (services.IssueResponse, error) {
				assert.Nil(t, req.Milestone)
				assert.Nil(t, req.Assignees)
				assert.Nil(t, req.Labels)
				return services.IssueResponse{}, pkgerrors.BadRequest("title is required")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues", strings.NewReader(`{"body":"missing title"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateIssue(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get validates invalid issue number", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/nope", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "nope"})
		rec := httptest.NewRecorder()

		h.GetIssue(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch invalid json and service conflict", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{bad`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = IssueHandler{Service: &mockIssueRouteService{
			updateIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error) {
				require.NotNil(t, req.Assignees)
				assert.Empty(t, *req.Assignees)
				return services.IssueResponse{}, pkgerrors.Conflict("issue has changed")
			},
		}}
		req = httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{"assignees":[]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusConflict, rec.Code)
	})
}

func TestIssues_Cov_CommentBranches(t *testing.T) {
	t.Run("post comment validates auth route number and json", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/comments", strings.NewReader(`{"body":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		rec := httptest.NewRecorder()
		h.PostIssueComment(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/nope/comments", strings.NewReader(`{"body":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "nope"})
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PostIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/comments", strings.NewReader(`{bad`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PostIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post and list comment service errors propagate", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
				return services.IssueCommentResponse{}, pkgerrors.BadRequest("body is required")
			},
			listIssueCommentsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error) {
				return nil, "", 0, pkgerrors.NotFound("issue not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/comments", strings.NewReader(`{"body":""}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostIssueComment(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/comments?per_page=bad", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		rec = httptest.NewRecorder()
		h.ListIssueComments(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/comments", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		rec = httptest.NewRecorder()
		h.ListIssueComments(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get patch delete comment validation and errors", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			getIssueCommentFn: func(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (services.IssueCommentResponse, error) {
				return services.IssueCommentResponse{}, pkgerrors.NotFound("comment not found")
			},
			updateCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req services.UpdateIssueCommentInput) (services.IssueCommentResponse, error) {
				return services.IssueCommentResponse{}, pkgerrors.Forbidden("cannot edit comment")
			},
			deleteCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error {
				return pkgerrors.Forbidden("cannot delete comment")
			},
		}}

		getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/comments/bad", nil)
		getReq = withRouteParams(getReq, map[string]string{"owner": "alice", "repo": "demo", "id": "bad"})
		getRec := httptest.NewRecorder()
		h.GetIssueComment(getRec, getReq)
		require.Equal(t, http.StatusBadRequest, getRec.Code)

		getReq = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/comments/31", nil)
		getReq = withRouteParams(getReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
		getRec = httptest.NewRecorder()
		h.GetIssueComment(getRec, getReq)
		require.Equal(t, http.StatusNotFound, getRec.Code)

		patchReq := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/comments/31", strings.NewReader(`{bad`))
		patchReq = withRouteParams(patchReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
		patchReq = withAuth(patchReq, 7, "alice")
		patchRec := httptest.NewRecorder()
		h.PatchIssueComment(patchRec, patchReq)
		require.Equal(t, http.StatusBadRequest, patchRec.Code)

		patchReq = httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/comments/31", strings.NewReader(`{"body":"edited"}`))
		patchReq = withRouteParams(patchReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
		patchReq = withAuth(patchReq, 7, "alice")
		patchRec = httptest.NewRecorder()
		h.PatchIssueComment(patchRec, patchReq)
		require.Equal(t, http.StatusForbidden, patchRec.Code)

		delReq := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/comments/31", nil)
		delReq = withRouteParams(delReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
		delReq = withAuth(delReq, 7, "alice")
		delRec := httptest.NewRecorder()
		h.DeleteIssueComment(delRec, delReq)
		require.Equal(t, http.StatusForbidden, delRec.Code)
	})
}
