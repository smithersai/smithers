package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGithubImport_Cov_StartImportValidationAndServiceErrors(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/github/import", strings.NewReader(`{"owner":"octo","repo":"demo"}`))
		rec := httptest.NewRecorder()

		h.StartImport(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service unavailable", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/github/import", strings.NewReader(`{"owner":"octo","repo":"demo"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.StartImport(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			startFn: func(context.Context, services.ImportGitHubRepoInput) (services.ImportJob, error) {
				t.Fatal("service should not be called")
				return services.ImportJob{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/github/import", strings.NewReader(`{`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.StartImport(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service validation error", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			startFn: func(context.Context, services.ImportGitHubRepoInput) (services.ImportJob, error) {
				return services.ImportJob{}, pkgerrors.BadRequest("repository is required")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/github/import", strings.NewReader(`{"owner":"octo"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.StartImport(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestGithubImport_Cov_GetAndStreamBranches(t *testing.T) {
	t.Parallel()

	t.Run("get requires auth", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
		req = withRouteParams(req, map[string]string{"id": "job-1"})
		rec := httptest.NewRecorder()

		h.GetImportJob(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("get service error", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{}, pkgerrors.NotFound("import job not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
		req = withRouteParams(req, map[string]string{"id": "job-1"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.GetImportJob(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("streaming unsupported", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
		req.Header.Set("Accept", "text/event-stream")
		req = withRouteParams(req, map[string]string{"id": "job-1"})
		req = withAuth(req, 7, "alice")
		rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}

		h.GetImportJob(rec, req)

		underlying := rec.ResponseWriter.(*httptest.ResponseRecorder)
		require.Equal(t, http.StatusInternalServerError, underlying.Code)
		assert.Contains(t, underlying.Body.String(), "streaming unsupported")
	})

	t.Run("initial stream service error before headers", func(t *testing.T) {
		t.Parallel()

		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{}, pkgerrors.NotFound("import job not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
		req.Header.Set("Accept", "text/event-stream")
		req = withRouteParams(req, map[string]string{"id": "job-1"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.GetImportJob(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestGithubImport_Cov_StreamEventMarshalFailure(t *testing.T) {
	t.Parallel()

	ok := writeImportStreamEvent(httptest.NewRecorder(), "bad", map[string]any{"fn": func() {}})
	assert.False(t, ok)
	assert.True(t, importJobTerminal(services.ImportJob{Status: "ready"}))
	assert.True(t, importJobTerminal(services.ImportJob{Status: "failed"}))
	assert.False(t, importJobTerminal(services.ImportJob{Status: "cloning"}))
}
