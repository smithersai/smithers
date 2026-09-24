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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type protectedBookmarksCovService struct {
	upsertFn func(context.Context, *db.User, string, string, services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error)
	listFn   func(context.Context, *db.User, string, string, int, int) ([]services.ProtectedBookmarkResponse, error)
	deleteFn func(context.Context, *db.User, string, string, string) error
}

func (s protectedBookmarksCovService) UpsertProtectedBookmark(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error) {
	return s.upsertFn(ctx, actor, owner, repo, input)
}

func (s protectedBookmarksCovService) ListProtectedBookmarks(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]services.ProtectedBookmarkResponse, error) {
	return s.listFn(ctx, viewer, owner, repo, page, perPage)
}

func (s protectedBookmarksCovService) DeleteProtectedBookmark(ctx context.Context, actor *db.User, owner, repo, pattern string) error {
	return s.deleteFn(ctx, actor, owner, repo, pattern)
}

func TestProtectedBookmarks_Cov_UpsertListDelete(t *testing.T) {
	t.Parallel()

	t.Run("upsert success", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{
			upsertFn: func(_ context.Context, actor *db.User, owner, repo string, input services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error) {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "main", input.Pattern)
				assert.Equal(t, int64(2), input.RequireHumanApprovals)
				assert.True(t, input.RequireAgentLGTM)
				assert.True(t, input.RequireStatusChecks)
				assert.Equal(t, []string{"ci/test"}, input.RequiredStatusContexts)
				return services.ProtectedBookmarkResponse{ID: 1, Pattern: input.Pattern, RequireHumanApprovals: input.RequireHumanApprovals, RequireAgentLGTM: input.RequireAgentLGTM, RequireStatusChecks: true, RequiredStatusContexts: input.RequiredStatusContexts}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/protected-bookmarks", strings.NewReader(`{"pattern":"main","require_human_approvals":2,"require_agent_lgtm":true,"require_status_checks":true,"required_status_contexts":["ci/test"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.UpsertProtectedBookmark(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"pattern":"main"`)
		assert.Contains(t, rec.Body.String(), `"require_human_approvals":2`)
		assert.Contains(t, rec.Body.String(), `"require_agent_lgtm":true`)
	})

	t.Run("list success", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{
			listFn: func(_ context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]services.ProtectedBookmarkResponse, error) {
				assert.Nil(t, viewer)
				assert.Equal(t, 2, page)
				assert.Equal(t, 10, perPage)
				return []services.ProtectedBookmarkResponse{{ID: 1, Pattern: "main"}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/protected-bookmarks?page=2&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListProtectedBookmarks(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"pattern":"main"`)
	})

	t.Run("delete success", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{
			deleteFn: func(_ context.Context, actor *db.User, owner, repo, pattern string) error {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "release/*", pattern)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/protected-bookmarks/release/*", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "pattern": "release/*"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteProtectedBookmark(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}

func TestProtectedBookmarks_Cov_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("upsert requires auth", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/protected-bookmarks", strings.NewReader(`{"pattern":"main"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.UpsertProtectedBookmark(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("upsert invalid json", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice/demo/protected-bookmarks", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.UpsertProtectedBookmark(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/protected-bookmarks?page=0", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListProtectedBookmarks(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete missing pattern", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/protected-bookmarks/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteProtectedBookmark(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete service error", func(t *testing.T) {
		t.Parallel()

		h := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{
			deleteFn: func(context.Context, *db.User, string, string, string) error {
				return pkgerrors.NotFound("protected bookmark not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/protected-bookmarks/main", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "pattern": "main"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteProtectedBookmark(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}
