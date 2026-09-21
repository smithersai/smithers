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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestLFS_Cov_ConfirmDeleteAndListErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("confirm invalid json", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/confirm", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.PostConfirm(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("confirm service error", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{
			confirmUploadFn: func(context.Context, *db.User, string, string, services.LFSConfirmUploadInput) (db.LfsObject, error) {
				return db.LfsObject{}, pkgerrors.Conflict("object size mismatch")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/confirm", strings.NewReader(`{"oid":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.PostConfirm(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("delete service error", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{
			deleteObjectFn: func(context.Context, *db.User, string, string, string) error {
				return pkgerrors.NotFound("object not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/lfs/objects/a", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "oid": "a"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteObject(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("list invalid pagination", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/lfs/objects?page=0", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.GetObjects(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestLFS_Cov_RouteParamBranches(t *testing.T) {
	t.Parallel()

	t.Run("batch missing repo", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice//lfs/batch", strings.NewReader(`{"operation":"download"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		rec := httptest.NewRecorder()

		h.PostBatch(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("batch passes nil viewer when unauthenticated", func(t *testing.T) {
		t.Parallel()

		h := LFSHandler{Service: &mockLFSRouteService{
			batchFn: func(_ context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
				assert.Nil(t, actor)
				assert.Equal(t, "download", input.Operation)
				return services.LFSBatchResponse{Transfer: "basic"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"download"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.PostBatch(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
	})
}
