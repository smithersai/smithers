package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockWorkflowArtifactRouteService struct {
	issueUploadURLFn func(ctx context.Context, run db.WorkflowRun, input services.WorkflowArtifactUploadInput) (services.WorkflowArtifactUploadResult, error)
	confirmUploadFn  func(ctx context.Context, run db.WorkflowRun, name string) (db.WorkflowArtifact, error)
	listArtifactsFn  func(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error)
	getDownloadURLFn func(ctx context.Context, repositoryID, runID int64, name string) (services.WorkflowArtifactDownloadResult, error)
	deleteArtifactFn func(ctx context.Context, repositoryID, runID int64, name string) error
}

func (m *mockWorkflowArtifactRouteService) IssueUploadURL(ctx context.Context, run db.WorkflowRun, input services.WorkflowArtifactUploadInput) (services.WorkflowArtifactUploadResult, error) {
	if m.issueUploadURLFn != nil {
		return m.issueUploadURLFn(ctx, run, input)
	}
	return services.WorkflowArtifactUploadResult{}, nil
}

func (m *mockWorkflowArtifactRouteService) ConfirmUpload(ctx context.Context, run db.WorkflowRun, name, declaredSHA256 string) (db.WorkflowArtifact, error) {
	if m.confirmUploadFn != nil {
		return m.confirmUploadFn(ctx, run, name)
	}
	return db.WorkflowArtifact{}, nil
}

func (m *mockWorkflowArtifactRouteService) ListArtifacts(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error) {
	if m.listArtifactsFn != nil {
		return m.listArtifactsFn(ctx, repositoryID, runID)
	}
	return nil, nil
}

func (m *mockWorkflowArtifactRouteService) GetDownloadURL(ctx context.Context, repositoryID, runID int64, name string) (services.WorkflowArtifactDownloadResult, error) {
	if m.getDownloadURLFn != nil {
		return m.getDownloadURLFn(ctx, repositoryID, runID, name)
	}
	return services.WorkflowArtifactDownloadResult{}, nil
}

func (m *mockWorkflowArtifactRouteService) DeleteArtifact(ctx context.Context, repositoryID, runID int64, name string) error {
	if m.deleteArtifactFn != nil {
		return m.deleteArtifactFn(ctx, repositoryID, runID, name)
	}
	return nil
}

type repeatingByteReader struct {
	remaining int64
	value     byte
}

func (r *repeatingByteReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}

	n := len(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := 0; i < n; i++ {
		p[i] = r.value
	}
	r.remaining -= int64(n)
	return n, nil
}

func TestWorkflowArtifactHandler_ListArtifacts_ReturnsArtifacts(t *testing.T) {
	t.Parallel()

	handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
		listArtifactsFn: func(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error) {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(55), runID)
			return []db.WorkflowArtifact{
				{
					ID:            1,
					RepositoryID:  repositoryID,
					WorkflowRunID: runID,
					Name:          "build.tar.gz",
					Size:          1024,
					ContentType:   "application/gzip",
					Status:        "ready",
					ExpiresAt:     time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC),
					CreatedAt:     time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
					UpdatedAt:     time.Date(2026, 3, 1, 12, 1, 0, 0, time.UTC),
				},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/actions/runs/55/artifacts", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "55"})
	rec := httptest.NewRecorder()

	handler.ListArtifacts(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var body listArtifactsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Artifacts, 1)
	assert.Equal(t, "build.tar.gz", body.Artifacts[0].Name)
	assert.Equal(t, "ready", body.Artifacts[0].Status)
}

func TestWorkflowArtifactHandler_PostInternalUploadURL_ReturnsSignedURL(t *testing.T) {
	t.Parallel()

	handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
		issueUploadURLFn: func(ctx context.Context, run db.WorkflowRun, input services.WorkflowArtifactUploadInput) (services.WorkflowArtifactUploadResult, error) {
			assert.Equal(t, int64(55), run.ID)
			assert.Equal(t, "build.tar.gz", input.Name)
			assert.Equal(t, int64(1024), input.Size)
			return services.WorkflowArtifactUploadResult{
				Artifact: db.WorkflowArtifact{
					ID:            3,
					RepositoryID:  run.RepositoryID,
					WorkflowRunID: run.ID,
					Name:          input.Name,
					Size:          input.Size,
					ContentType:   "application/gzip",
					Status:        "pending",
					ExpiresAt:     time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC),
					CreatedAt:     time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
					UpdatedAt:     time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
				},
				UploadURL: "https://upload.example.test",
				UploadHeaders: map[string]string{
					"Content-Type":               "application/gzip",
					"x-goog-if-generation-match": "0",
				},
			}, nil
		},
	}}

	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/runs/55/artifacts/upload-url",
		bytes.NewBufferString(`{"name":"build.tar.gz","size":1024,"content_type":"application/gzip"}`),
	)
	req = withRouteParams(req, map[string]string{"id": "55"})
	req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
	rec := httptest.NewRecorder()

	handler.PostInternalUploadURL(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var body workflowArtifactUploadResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "build.tar.gz", body.Name)
	assert.Equal(t, "https://upload.example.test", body.UploadURL)
	assert.Equal(t, map[string]string{
		"Content-Type":               "application/gzip",
		"x-goog-if-generation-match": "0",
	}, body.UploadHeaders)
}

func TestWorkflowArtifactHandler_PostInternalUploadURL_BodyTooLarge(t *testing.T) {
	handler := WorkflowArtifactHandler{
		Service:            &mockWorkflowArtifactRouteService{},
		MaxUploadBodyBytes: 32,
	}

	body := io.MultiReader(
		strings.NewReader(`{"name":"`),
		&repeatingByteReader{remaining: 64, value: 'a'},
		strings.NewReader(`","size":1}`),
	)
	req := httptest.NewRequest(http.MethodPost, "/internal/runs/55/artifacts/upload-url", body)
	req = withRouteParams(req, map[string]string{"id": "55"})
	req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
	rec := httptest.NewRecorder()

	handler.PostInternalUploadURL(rec, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "request body too large", payload["message"])
}

func TestWorkflowArtifactHandler_PostInternalConfirm_DelegatesToService(t *testing.T) {
	t.Parallel()

	handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
		confirmUploadFn: func(ctx context.Context, run db.WorkflowRun, name string) (db.WorkflowArtifact, error) {
			assert.Equal(t, int64(55), run.ID)
			assert.Equal(t, "build.tar.gz", name)
			return db.WorkflowArtifact{
				ID:            3,
				RepositoryID:  run.RepositoryID,
				WorkflowRunID: run.ID,
				Name:          name,
				Size:          1024,
				ContentType:   "application/gzip",
				Status:        "ready",
				ExpiresAt:     time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC),
				CreatedAt:     time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
				UpdatedAt:     time.Date(2026, 3, 1, 12, 1, 0, 0, time.UTC),
			}, nil
		},
	}}

	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/runs/55/artifacts/confirm",
		bytes.NewBufferString(`{"name":"build.tar.gz"}`),
	)
	req = withRouteParams(req, map[string]string{"id": "55"})
	req = withWorkflowRunContext(req, db.WorkflowRun{ID: 55, RepositoryID: 101})
	rec := httptest.NewRecorder()

	handler.PostInternalConfirm(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body workflowArtifactResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ready", body.Status)
}

func TestWorkflowArtifactHandler_DeleteArtifact_ReturnsNoContent(t *testing.T) {
	t.Parallel()

	handler := WorkflowArtifactHandler{Service: &mockWorkflowArtifactRouteService{
		deleteArtifactFn: func(ctx context.Context, repositoryID, runID int64, name string) error {
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, int64(55), runID)
			assert.Equal(t, "build.tar.gz", name)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/actions/runs/55/artifacts/build.tar.gz", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "55", "name": "build.tar.gz"})
	rec := httptest.NewRecorder()

	handler.DeleteArtifact(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
}
