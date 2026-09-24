package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestGithubImport_H_GetImportJobBranches(t *testing.T) {
	t.Run("requires auth", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{}}
		rec := httptest.NewRecorder()

		h.GetImportJob(rec, httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("requires service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitHubImportHandler{}).GetImportJob(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{}, pkgerrors.NotFound("import job not found")
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil), 7, "alice")
		req = githubImportHRouteID(req, "job-1")
		rec := httptest.NewRecorder()

		h.GetImportJob(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestGithubImport_H_StreamImportJobBranches(t *testing.T) {
	t.Run("non flusher", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{}}
		rec := &nonFlusherWriter{ResponseWriter: httptest.NewRecorder()}

		h.streamImportJob(rec, httptest.NewRequest(http.MethodGet, "/stream", nil), 7, "job-1")

		require.Equal(t, http.StatusInternalServerError, rec.ResponseWriter.(*httptest.ResponseRecorder).Code)
	})

	t.Run("initial service error", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{}, pkgerrors.NotFound("missing")
			},
		}}
		rec := httptest.NewRecorder()

		h.streamImportJob(rec, httptest.NewRequest(http.MethodGet, "/stream", nil), 7, "job-1")

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("initial terminal job returns after first event", func(t *testing.T) {
		calls := 0
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				calls++
				return services.ImportJob{ImportJobID: "job-1", Status: "failed"}, nil
			},
		}}
		rec := httptest.NewRecorder()

		h.streamImportJob(rec, httptest.NewRequest(http.MethodGet, "/stream", nil), 7, "job-1")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, calls)
		assert.Contains(t, rec.Body.String(), "event: import_job")
	})

	t.Run("write failure returns", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{ImportJobID: "job-1", Status: "ready"}, nil
			},
		}}

		h.streamImportJob(&githubImportHFailWriter{header: http.Header{}}, httptest.NewRequest(http.MethodGet, "/stream", nil), 7, "job-1")
	})

	t.Run("canceled context exits after first non-terminal event", func(t *testing.T) {
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				return services.ImportJob{ImportJobID: "job-1", Status: "cloning"}, nil
			},
		}}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
		rec := httptest.NewRecorder()

		h.streamImportJob(rec, req, 7, "job-1")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"status":"cloning"`)
	})

	t.Run("poll write failure returns", func(t *testing.T) {
		oldPoll := githubImportStreamPollInterval
		oldMax := githubImportStreamMaxDuration
		t.Cleanup(func() {
			githubImportStreamPollInterval = oldPoll
			githubImportStreamMaxDuration = oldMax
		})
		githubImportStreamPollInterval = time.Millisecond
		githubImportStreamMaxDuration = time.Hour
		calls := 0
		h := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
			getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				calls++
				status := "cloning"
				if calls > 1 {
					status = "ready"
				}
				return services.ImportJob{ImportJobID: "job-1", Status: status}, nil
			},
		}}
		w := &githubImportHFailAfterWriter{header: http.Header{}, failOnWrite: 2}

		h.streamImportJob(w, httptest.NewRequest(http.MethodGet, "/stream", nil), 7, "job-1")

		assert.GreaterOrEqual(t, calls, 2)
		assert.Equal(t, 2, w.writes)
	})
}

func githubImportHRouteID(req *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

type githubImportHFailWriter struct {
	header http.Header
}

func (w *githubImportHFailWriter) Header() http.Header { return w.header }
func (w *githubImportHFailWriter) WriteHeader(int)     {}
func (w *githubImportHFailWriter) Flush()              {}
func (w *githubImportHFailWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

type githubImportHFailAfterWriter struct {
	header      http.Header
	failOnWrite int
	writes      int
}

func (w *githubImportHFailAfterWriter) Header() http.Header { return w.header }
func (w *githubImportHFailAfterWriter) WriteHeader(int)     {}
func (w *githubImportHFailAfterWriter) Flush()              {}
func (w *githubImportHFailAfterWriter) Write(b []byte) (int, error) {
	w.writes++
	if w.writes == w.failOnWrite {
		return 0, errors.New("write failed")
	}
	return len(b), nil
}
