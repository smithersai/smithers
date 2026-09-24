package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestProtectedBookmarks_H_RemainingBranches(t *testing.T) {
	t.Run("upsert route and service errors", func(t *testing.T) {
		handler := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		req := withAuth(httptest.NewRequest(http.MethodPut, "/protected-bookmarks", strings.NewReader(`{"pattern":"main"}`)), 7, "alice")
		rec := httptest.NewRecorder()
		handler.UpsertProtectedBookmark(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = protectedBookmarksCovService{
			upsertFn: func(context.Context, *db.User, string, string, services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error) {
				return services.ProtectedBookmarkResponse{}, pkgerrors.Forbidden("denied")
			},
		}
		req = withAuth(httptest.NewRequest(http.MethodPut, "/protected-bookmarks", strings.NewReader(`{"pattern":"main"}`)), 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.UpsertProtectedBookmark(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("list route and service errors", func(t *testing.T) {
		handler := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		rec := httptest.NewRecorder()
		handler.ListProtectedBookmarks(rec, httptest.NewRequest(http.MethodGet, "/protected-bookmarks", nil))
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = protectedBookmarksCovService{
			listFn: func(context.Context, *db.User, string, string, int, int) ([]services.ProtectedBookmarkResponse, error) {
				return nil, pkgerrors.Internal("list failed")
			},
		}
		req := httptest.NewRequest(http.MethodGet, "/protected-bookmarks", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.ListProtectedBookmarks(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("delete auth and owner errors", func(t *testing.T) {
		handler := ProtectedBookmarkHandler{Service: protectedBookmarksCovService{}}
		rec := httptest.NewRecorder()
		handler.DeleteProtectedBookmark(rec, httptest.NewRequest(http.MethodDelete, "/protected-bookmarks/main", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req := withAuth(httptest.NewRequest(http.MethodDelete, "/protected-bookmarks/main", nil), 7, "alice")
		rec = httptest.NewRecorder()
		handler.DeleteProtectedBookmark(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
