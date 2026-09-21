package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockWikiRouteService struct {
	listWikiPagesFn  func(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error)
	getWikiPageFn    func(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error)
	createWikiPageFn func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error)
	updateWikiPageFn func(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error)
	deleteWikiPageFn func(ctx context.Context, actor *db.User, owner, repo, slug string) error
	listRevisionsFn  func(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]services.WikiRevisionResponse, int64, error)
}

func (m *mockWikiRouteService) ListWikiPages(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
	if m.listWikiPagesFn != nil {
		return m.listWikiPagesFn(ctx, viewer, owner, repo, input)
	}
	return nil, 0, nil
}

func (m *mockWikiRouteService) GetWikiPage(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error) {
	if m.getWikiPageFn != nil {
		return m.getWikiPageFn(ctx, viewer, owner, repo, slug)
	}
	return services.WikiPageResponse{}, nil
}

func (m *mockWikiRouteService) CreateWikiPage(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error) {
	if m.createWikiPageFn != nil {
		return m.createWikiPageFn(ctx, actor, owner, repo, req)
	}
	return services.WikiPageResponse{}, nil
}

func (m *mockWikiRouteService) UpdateWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error) {
	if m.updateWikiPageFn != nil {
		return m.updateWikiPageFn(ctx, actor, owner, repo, slug, req)
	}
	return services.WikiPageResponse{}, nil
}

func (m *mockWikiRouteService) DeleteWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string) error {
	if m.deleteWikiPageFn != nil {
		return m.deleteWikiPageFn(ctx, actor, owner, repo, slug)
	}
	return nil
}

func (m *mockWikiRouteService) ListWikiRevisions(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]services.WikiRevisionResponse, int64, error) {
	if m.listRevisionsFn != nil {
		return m.listRevisionsFn(ctx, viewer, owner, repo, slug, page, perPage)
	}
	return []services.WikiRevisionResponse{}, 0, nil
}

func sampleWikiPageResponse() services.WikiPageResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.WikiPageResponse{
		ID:    7,
		Slug:  "home",
		Title: "Home",
		Body:  "# Welcome",
		Author: services.WikiAuthorSummary{
			ID:    1,
			Login: "alice",
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func withWikiRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func TestListWikiPages(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		listWikiPagesFn: func(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "guide", input.Query)
			assert.Equal(t, 2, input.Page)
			assert.Equal(t, 10, input.PerPage)
			return []services.WikiPageResponse{
				{Slug: "guide", Title: "Guide"},
			}, 1, nil
		},
	}

	handler := ListWikiPages(mockSvc)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki?q=guide&page=2&per_page=10", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))

	var pages []services.WikiPageResponse
	err := json.Unmarshal(rec.Body.Bytes(), &pages)
	require.NoError(t, err)
	require.Len(t, pages, 1)
	assert.Equal(t, "guide", pages[0].Slug)
}

func TestGetWikiPage(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		getWikiPageFn: func(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error) {
			assert.Equal(t, "home", slug)
			return sampleWikiPageResponse(), nil
		},
	}

	handler := GetWikiPage(mockSvc)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/home", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var page services.WikiPageResponse
	err := json.Unmarshal(rec.Body.Bytes(), &page)
	require.NoError(t, err)
	assert.Equal(t, "home", page.Slug)
	assert.Equal(t, "Home", page.Title)
}

func TestCreateWikiPage(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		createWikiPageFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error) {
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "Home", req.Title)
			assert.Equal(t, "home", req.Slug)
			assert.Equal(t, "# Welcome", req.Body)
			return sampleWikiPageResponse(), nil
		},
	}

	bodyJSON, err := json.Marshal(map[string]any{
		"title": "Home",
		"slug":  "home",
		"body":  "# Welcome",
	})
	require.NoError(t, err)

	handler := CreateWikiPage(mockSvc)
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/wiki", bytes.NewReader(bodyJSON))
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 1, Username: "alice"}))
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusCreated, rec.Code)
}

func TestCreateWikiPage_InvalidJSON(t *testing.T) {
	handler := CreateWikiPage(&mockWikiRouteService{})
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/wiki", bytes.NewBufferString("{"))
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 1, Username: "alice"}))
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestUpdateWikiPage(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		updateWikiPageFn: func(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error) {
			assert.Equal(t, "home", slug)
			require.NotNil(t, req.Title)
			require.NotNil(t, req.Body)
			assert.Equal(t, "Start Here", *req.Title)
			assert.Equal(t, "Updated body", *req.Body)
			return services.WikiPageResponse{Slug: "home", Title: "Start Here", Body: "Updated body"}, nil
		},
	}

	bodyJSON, err := json.Marshal(map[string]any{
		"title": "Start Here",
		"body":  "Updated body",
	})
	require.NoError(t, err)

	handler := UpdateWikiPage(mockSvc)
	req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/wiki/home", bytes.NewReader(bodyJSON))
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 1, Username: "alice"}))
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestDeleteWikiPage(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		deleteWikiPageFn: func(ctx context.Context, actor *db.User, owner, repo, slug string) error {
			assert.Equal(t, "home", slug)
			return nil
		},
	}

	handler := DeleteWikiPage(mockSvc)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/wiki/home", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 1, Username: "alice"}))
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSearchWikiPages(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		listWikiPagesFn: func(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
			assert.Equal(t, "guide", input.Query)
			return []services.WikiPageResponse{
				{Slug: "guide", Title: "Guide"},
			}, 1, nil
		},
	}

	handler := SearchWikiPages(mockSvc)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/search?q=guide", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var pages []services.WikiPageResponse
	err := json.Unmarshal(rec.Body.Bytes(), &pages)
	require.NoError(t, err)
	require.Len(t, pages, 1)
	assert.Equal(t, "guide", pages[0].Slug)
}

func TestSearchWikiPages_RequiresQuery(t *testing.T) {
	handler := SearchWikiPages(&mockWikiRouteService{})
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/search", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestListWikiRevisions(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		listRevisionsFn: func(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]services.WikiRevisionResponse, int64, error) {
			assert.Equal(t, "home", slug)
			return []services.WikiRevisionResponse{
				{ID: 7, Slug: "home", Title: "Home"},
			}, 1, nil
		},
	}

	handler := ListWikiRevisions(mockSvc)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/wiki/home/revisions", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var revisions []services.WikiRevisionResponse
	err := json.Unmarshal(rec.Body.Bytes(), &revisions)
	require.NoError(t, err)
	require.Len(t, revisions, 1)
	assert.Equal(t, "home", revisions[0].Slug)
}

func TestDeleteWikiPage_RequiresAuth(t *testing.T) {
	mockSvc := &mockWikiRouteService{
		deleteWikiPageFn: func(ctx context.Context, actor *db.User, owner, repo, slug string) error {
			return pkgerrors.NotFound("should not be called")
		},
	}

	handler := DeleteWikiPage(mockSvc)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/wiki/home", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
