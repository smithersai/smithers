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

type mockLabelRouteService struct {
	createLabelFn            func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLabelInput) (db.Label, error)
	listLabelsFn             func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error)
	getLabelFn               func(ctx context.Context, viewer *db.User, owner, repo string, id int64) (db.Label, error)
	updateLabelFn            func(ctx context.Context, actor *db.User, owner, repo string, id int64, req services.UpdateLabelInput) (db.Label, error)
	deleteLabelFn            func(ctx context.Context, actor *db.User, owner, repo string, id int64) error
	addLabelsToIssueFn       func(ctx context.Context, actor *db.User, owner, repo string, number int64, names []string) ([]db.Label, error)
	listIssueLabelsFn        func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.Label, int64, error)
	removeIssueLabelByNameFn func(ctx context.Context, actor *db.User, owner, repo string, number int64, labelName string) error
}

func (m *mockLabelRouteService) CreateLabel(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLabelInput) (db.Label, error) {
	if m.createLabelFn != nil {
		return m.createLabelFn(ctx, actor, owner, repo, req)
	}
	return db.Label{}, nil
}

func (m *mockLabelRouteService) ListLabels(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error) {
	if m.listLabelsFn != nil {
		return m.listLabelsFn(ctx, viewer, owner, repo, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockLabelRouteService) GetLabel(ctx context.Context, viewer *db.User, owner, repo string, id int64) (db.Label, error) {
	if m.getLabelFn != nil {
		return m.getLabelFn(ctx, viewer, owner, repo, id)
	}
	return db.Label{}, nil
}

func (m *mockLabelRouteService) UpdateLabel(ctx context.Context, actor *db.User, owner, repo string, id int64, req services.UpdateLabelInput) (db.Label, error) {
	if m.updateLabelFn != nil {
		return m.updateLabelFn(ctx, actor, owner, repo, id, req)
	}
	return db.Label{}, nil
}

func (m *mockLabelRouteService) DeleteLabel(ctx context.Context, actor *db.User, owner, repo string, id int64) error {
	if m.deleteLabelFn != nil {
		return m.deleteLabelFn(ctx, actor, owner, repo, id)
	}
	return nil
}

func (m *mockLabelRouteService) AddLabelsToIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, names []string) ([]db.Label, error) {
	if m.addLabelsToIssueFn != nil {
		return m.addLabelsToIssueFn(ctx, actor, owner, repo, number, names)
	}
	return nil, nil
}

func (m *mockLabelRouteService) ListIssueLabels(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.Label, int64, error) {
	if m.listIssueLabelsFn != nil {
		return m.listIssueLabelsFn(ctx, viewer, owner, repo, number, page, perPage)
	}
	return nil, 0, nil
}

func (m *mockLabelRouteService) RemoveIssueLabelByName(ctx context.Context, actor *db.User, owner, repo string, number int64, labelName string) error {
	if m.removeIssueLabelByNameFn != nil {
		return m.removeIssueLabelByNameFn(ctx, actor, owner, repo, number, labelName)
	}
	return nil
}

func TestLabelHandler_RepoLabelEndpoints(t *testing.T) {
	t.Parallel()

	t.Run("post invalid json", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/labels", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostRepoLabel(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post created", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			createLabelFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLabelInput) (db.Label, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "bug", req.Name)
				return db.Label{ID: 4, Name: "bug", Color: "#d73a4a", Description: "desc"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/labels", strings.NewReader(`{"name":"bug","color":"#d73a4a","description":"desc"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostRepoLabel(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("get list with pagination headers", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			listLabelsFn: func(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error) {
				assert.Nil(t, viewer)
				assert.Equal(t, 2, page)
				assert.Equal(t, 10, perPage)
				return []db.Label{{ID: 1, Name: "bug", Color: "#d73a4a"}}, 22, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/labels?page=2&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.GetRepoLabels(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "22", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
	})

	t.Run("get by id", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			getLabelFn: func(ctx context.Context, viewer *db.User, owner, repo string, id int64) (db.Label, error) {
				assert.Equal(t, int64(8), id)
				return db.Label{ID: 8, Name: "bug", Color: "#d73a4a"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/labels/8", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		rec := httptest.NewRecorder()
		h.GetRepoLabel(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("patch invalid id", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/labels/not-id", strings.NewReader(`{"name":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "not-id"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepoLabel(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch success", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			updateLabelFn: func(ctx context.Context, actor *db.User, owner, repo string, id int64, req services.UpdateLabelInput) (db.Label, error) {
				assert.Equal(t, int64(8), id)
				assert.Equal(t, "updated", *req.Name)
				return db.Label{ID: 8, Name: "updated", Color: "#d73a4a"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/labels/8", strings.NewReader(`{"name":"updated"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchRepoLabel(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var payload db.Label
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(8), payload.ID)
	})

	t.Run("delete success", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/labels/8", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteRepoLabel(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("service api error propagation", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			createLabelFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLabelInput) (db.Label, error) {
				return db.Label{}, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/labels", strings.NewReader(`{"name":"bug","color":"#d73a4a"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostRepoLabel(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestLabelHandler_IssueLabelEndpoints(t *testing.T) {
	t.Parallel()

	t.Run("post invalid json", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/labels", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostIssueLabels(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post success", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			addLabelsToIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, names []string) ([]db.Label, error) {
				assert.Equal(t, int64(3), number)
				assert.Equal(t, []string{"bug", "docs"}, names)
				return []db.Label{{ID: 1, Name: "bug", Color: "#d73a4a"}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/labels", strings.NewReader(`{"labels":["bug","docs"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PostIssueLabels(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("get success", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			listIssueLabelsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.Label, int64, error) {
				assert.Equal(t, int64(3), number)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return []db.Label{{ID: 1, Name: "bug", Color: "#d73a4a"}}, 1, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/labels", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		rec := httptest.NewRecorder()
		h.GetIssueLabels(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "1", rec.Header().Get("X-Total-Count"))
	})

	t.Run("delete success", func(t *testing.T) {
		h := LabelHandler{Service: &mockLabelRouteService{
			removeIssueLabelByNameFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, labelName string) error {
				assert.Equal(t, int64(3), number)
				assert.Equal(t, "bug", labelName)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/3/labels/bug", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3", "name": "bug"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteIssueLabel(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}
