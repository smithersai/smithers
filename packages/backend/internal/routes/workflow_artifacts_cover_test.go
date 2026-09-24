package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWorkflowArtifacts_Cov_InternalDownloadAndRunContext(t *testing.T) {
	t.Parallel()

	t.Run("download success", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
			getDownloadURLFn: func(_ context.Context, repositoryID, runID int64, name string) (services.WorkflowArtifactDownloadResult, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, int64(55), runID)
				assert.Equal(t, "build.tar.gz", name)
				return services.WorkflowArtifactDownloadResult{
					Artifact:    workflowArtifactsCovArtifact(repositoryID, runID, name),
					DownloadURL: "https://download.example/build.tar.gz",
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/internal/runs/55/artifacts/build.tar.gz/download", nil)
		req = withRouteParams(req, map[string]string{"id": "55", "name": "build.tar.gz"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec := httptest.NewRecorder()

		handler.GetInternalDownloadURL(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body workflowArtifactDownloadResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "build.tar.gz", body.Name)
		assert.Equal(t, "https://download.example/build.tar.gz", body.DownloadURL)
	})

	t.Run("run token mismatch", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/internal/runs/56/artifacts/build.tar.gz/download", nil)
		req = withRouteParams(req, map[string]string{"id": "56", "name": "build.tar.gz"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec := httptest.NewRecorder()

		handler.GetInternalDownloadURL(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "not authorized")
	})

	t.Run("missing name", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/internal/runs/55/artifacts//download", nil)
		req = withRouteParams(req, map[string]string{"id": "55"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec := httptest.NewRecorder()

		handler.GetInternalDownloadURL(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestWorkflowArtifacts_Cov_PublicDownloadAndDeleteBranches(t *testing.T) {
	t.Parallel()

	t.Run("public download service error", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
			getDownloadURLFn: func(context.Context, int64, int64, string) (services.WorkflowArtifactDownloadResult, error) {
				return services.WorkflowArtifactDownloadResult{}, pkgerrors.NotFound("artifact not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/55/artifacts/a.txt/download", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a.txt"})
		rec := httptest.NewRecorder()

		handler.GetDownloadURL(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("delete missing repo context", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/actions/runs/55/artifacts/a.txt", nil)
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a.txt"})
		rec := httptest.NewRecorder()

		handler.DeleteArtifact(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("delete service error", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
			deleteArtifactFn: func(context.Context, int64, int64, string) error {
				return pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/actions/runs/55/artifacts/a.txt", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "55", "name": "a.txt"})
		rec := httptest.NewRecorder()

		handler.DeleteArtifact(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestWorkflowArtifacts_Cov_UploadConfirmErrorsAndDefaults(t *testing.T) {
	t.Parallel()

	t.Run("service unavailable", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{}
		req := httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/upload-url", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()

		handler.PostInternalUploadURL(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("confirm invalid json", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/confirm", strings.NewReader(`{`))
		req = withRouteParams(req, map[string]string{"id": "55"})
		req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
		rec := httptest.NewRecorder()

		handler.PostInternalConfirm(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("default max body size", func(t *testing.T) {
		t.Parallel()

		handler := WorkflowArtifactHandler{}
		assert.Equal(t, services.MaxWorkflowArtifactUploadSizeBytes, handler.maxUploadBodyBytes())
		handler.MaxUploadBodyBytes = 123
		assert.Equal(t, int64(123), handler.maxUploadBodyBytes())
	})
}

func workflowArtifactsCovArtifact(repositoryID, runID int64, name string) db.WorkflowArtifact {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	return db.WorkflowArtifact{
		ID:            9,
		RepositoryID:  repositoryID,
		WorkflowRunID: runID,
		Name:          name,
		Size:          12,
		ContentType:   "text/plain",
		Status:        "ready",
		ExpiresAt:     now.Add(time.Hour),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}
