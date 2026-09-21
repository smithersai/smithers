package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWiki_Cov_ListGetSearchRevisionBranches(t *testing.T) {
	t.Parallel()

	t.Run("list rejects invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := ListWikiPages(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki?page=0", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := ListWikiPages(&mockWikiRouteService{
			listWikiPagesFn: func(context.Context, *db.User, string, string, services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
				return nil, 0, pkgerrors.Forbidden("permission denied")
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("get requires slug", func(t *testing.T) {
		t.Parallel()
		handler := GetWikiPage(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "wiki slug is required")
	})

	t.Run("get propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := GetWikiPage(&mockWikiRouteService{
			getWikiPageFn: func(context.Context, *db.User, string, string, string) (services.WikiPageResponse, error) {
				return services.WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/home", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("search propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := SearchWikiPages(&mockWikiRouteService{
			listWikiPagesFn: func(context.Context, *db.User, string, string, services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
				return nil, 0, pkgerrors.Forbidden("permission denied")
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/search?q=guide", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("revisions reject invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := ListWikiRevisions(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/home/revisions?per_page=0", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("revisions propagate service error", func(t *testing.T) {
		t.Parallel()
		handler := ListWikiRevisions(&mockWikiRouteService{
			listRevisionsFn: func(context.Context, *db.User, string, string, string, int, int) ([]services.WikiRevisionResponse, int64, error) {
				return nil, 0, pkgerrors.NotFound("wiki page not found")
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/home/revisions", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestWiki_Cov_WriteBranches(t *testing.T) {
	t.Parallel()

	t.Run("create requires auth", func(t *testing.T) {
		t.Parallel()
		handler := CreateWikiPage(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/wiki", strings.NewReader(`{"title":"Home","body":"x"}`))
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("create propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := CreateWikiPage(&mockWikiRouteService{
			createWikiPageFn: func(context.Context, *db.User, string, string, services.CreateWikiPageInput) (services.WikiPageResponse, error) {
				return services.WikiPageResponse{}, pkgerrors.Conflict("slug already exists")
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/wiki", strings.NewReader(`{"title":"Home","slug":"home","body":"x"}`))
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("patch requires slug", func(t *testing.T) {
		t.Parallel()
		handler := UpdateWikiPage(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/wiki/", strings.NewReader(`{"title":"Home"}`))
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := UpdateWikiPage(&mockWikiRouteService{})
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/wiki/home", strings.NewReader(`{`))
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := UpdateWikiPage(&mockWikiRouteService{
			updateWikiPageFn: func(context.Context, *db.User, string, string, string, services.UpdateWikiPageInput) (services.WikiPageResponse, error) {
				return services.WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
			},
		})
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/wiki/home", strings.NewReader(`{"title":"Home"}`))
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("delete propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := DeleteWikiPage(&mockWikiRouteService{
			deleteWikiPageFn: func(context.Context, *db.User, string, string, string) error {
				return pkgerrors.NotFound("wiki page not found")
			},
		})
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/wiki/home", nil)
		req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}
