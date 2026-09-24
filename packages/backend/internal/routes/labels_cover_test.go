package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestLabels_Cov_HandlerBranches(t *testing.T) {
	t.Parallel()

	t.Run("post repo label requires auth", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/labels", strings.NewReader(`{"name":"bug"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.PostRepoLabel(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("list repo labels rejects invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			listLabelsFn: func(context.Context, *db.User, string, string, int, int) ([]db.Label, int64, error) {
				t.Fatal("service should not be called")
				return nil, 0, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/labels?per_page=not-a-number", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.GetRepoLabels(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get repo label propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			getLabelFn: func(context.Context, *db.User, string, string, int64) (db.Label, error) {
				return db.Label{}, pkgerrors.NotFound("label not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/labels/8", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		rec := httptest.NewRecorder()
		handler.GetRepoLabel(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("patch repo label rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/labels/8", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.PatchRepoLabel(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("patch repo label propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			updateLabelFn: func(context.Context, *db.User, string, string, int64, services.UpdateLabelInput) (db.Label, error) {
				return db.Label{}, pkgerrors.Conflict("label already exists")
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/labels/8", strings.NewReader(`{"name":"dupe"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.PatchRepoLabel(rec, req)

		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("delete repo label rejects invalid id", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/labels/nope", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "nope"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteRepoLabel(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete repo label propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			deleteLabelFn: func(context.Context, *db.User, string, string, int64) error {
				return pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/labels/8", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "8"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteRepoLabel(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("post issue labels rejects invalid issue number", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/nope/labels", strings.NewReader(`{"labels":["bug"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "nope"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.PostIssueLabels(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post issue labels propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			addLabelsToIssueFn: func(context.Context, *db.User, string, string, int64, []string) ([]db.Label, error) {
				return nil, pkgerrors.NotFound("issue not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/labels", strings.NewReader(`{"labels":["bug"]}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.PostIssueLabels(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("get issue labels rejects invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/labels?page=0", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		rec := httptest.NewRecorder()
		handler.GetIssueLabels(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete issue label requires name", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/3/labels/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteIssueLabel(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "label name is required")
	})

	t.Run("delete issue label propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := LabelHandler{Service: &mockLabelRouteService{
			removeIssueLabelByNameFn: func(context.Context, *db.User, string, string, int64, string) error {
				return pkgerrors.NotFound("label not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/3/labels/bug", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3", "name": "bug"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.DeleteIssueLabel(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}
