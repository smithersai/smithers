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

func TestWorkflowArtifacts_H_InternalBranches(t *testing.T) {
	t.Run("upload context and service errors", func(t *testing.T) {
		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/upload-url", strings.NewReader(`{"name":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec := httptest.NewRecorder()
		handler.PostInternalUploadURL(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler.Service = &mockWorkflowArtifactRouteService{
			issueUploadURLFn: func(context.Context, db.WorkflowRun, services.WorkflowArtifactUploadInput) (services.WorkflowArtifactUploadResult, error) {
				return services.WorkflowArtifactUploadResult{}, pkgerrors.BadRequest("bad artifact")
			},
		}
		req = httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/upload-url", strings.NewReader(`{"name":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"id": "55"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec = httptest.NewRecorder()
		handler.PostInternalUploadURL(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("confirm nil context and service errors", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/confirm", strings.NewReader(`{"name":"a"}`))
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec := httptest.NewRecorder()
		(&WorkflowArtifactHandler{}).PostInternalConfirm(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		rec = httptest.NewRecorder()
		handler.PostInternalConfirm(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler.Service = &mockWorkflowArtifactRouteService{
			confirmUploadFn: func(context.Context, db.WorkflowRun, string) (db.WorkflowArtifact, error) {
				return db.WorkflowArtifact{}, pkgerrors.NotFound("missing")
			},
		}
		req = httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/confirm", strings.NewReader(`{"name":"a"}`))
		req = withRouteParams(req, map[string]string{"id": "55"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec = httptest.NewRecorder()
		handler.PostInternalConfirm(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("internal download nil and service error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/internal/runs/55/artifacts/a/download", nil)
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec := httptest.NewRecorder()
		(&WorkflowArtifactHandler{}).GetInternalDownloadURL(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
			getDownloadURLFn: func(context.Context, int64, int64, string) (services.WorkflowArtifactDownloadResult, error) {
				return services.WorkflowArtifactDownloadResult{}, pkgerrors.Forbidden("denied")
			},
		}}
		rec = httptest.NewRecorder()
		handler.GetInternalDownloadURL(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestWorkflowArtifacts_H_PublicBranches(t *testing.T) {
	t.Run("list errors", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/runs/55/artifacts", nil)
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec := httptest.NewRecorder()
		(&WorkflowArtifactHandler{}).ListArtifacts(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		rec = httptest.NewRecorder()
		handler.ListArtifacts(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/nope/artifacts", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "nope"})
		rec = httptest.NewRecorder()
		handler.ListArtifacts(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = &mockWorkflowArtifactRouteService{
			listArtifactsFn: func(context.Context, int64, int64) ([]db.WorkflowArtifact, error) {
				return nil, pkgerrors.Internal("list failed")
			},
		}
		req = withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/55/artifacts", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec = httptest.NewRecorder()
		handler.ListArtifacts(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("download errors and success", func(t *testing.T) {
		req := withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/55/artifacts/a/download", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a"})
		rec := httptest.NewRecorder()
		(&WorkflowArtifactHandler{}).GetDownloadURL(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req = httptest.NewRequest(http.MethodGet, "/runs/55/artifacts/a/download", nil)
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a"})
		rec = httptest.NewRecorder()
		handler.GetDownloadURL(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/nope/artifacts/a/download", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "nope", "name": "a"})
		rec = httptest.NewRecorder()
		handler.GetDownloadURL(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/55/artifacts//download", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec = httptest.NewRecorder()
		handler.GetDownloadURL(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = &mockWorkflowArtifactRouteService{
			getDownloadURLFn: func(context.Context, int64, int64, string) (services.WorkflowArtifactDownloadResult, error) {
				return services.WorkflowArtifactDownloadResult{Artifact: workflowArtifactsCovArtifact(101, 55, "a"), DownloadURL: "https://example/a"}, nil
			},
		}
		req = withRepoContext(httptest.NewRequest(http.MethodGet, "/runs/55/artifacts/a/download", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a"})
		rec = httptest.NewRecorder()
		handler.GetDownloadURL(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("delete nil invalid and missing name", func(t *testing.T) {
		req := withRepoContext(httptest.NewRequest(http.MethodDelete, "/runs/55/artifacts/a", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a"})
		rec := httptest.NewRecorder()
		(&WorkflowArtifactHandler{}).DeleteArtifact(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req = withRepoContext(httptest.NewRequest(http.MethodDelete, "/runs/nope/artifacts/a", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "nope", "name": "a"})
		rec = httptest.NewRecorder()
		handler.DeleteArtifact(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = withRepoContext(httptest.NewRequest(http.MethodDelete, "/runs/55/artifacts/", nil), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55"})
		rec = httptest.NewRecorder()
		handler.DeleteArtifact(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
