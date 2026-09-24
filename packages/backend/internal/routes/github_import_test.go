package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockGitHubImportRouteService struct {
	startFn         func(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error)
	startTemplateFn func(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error)
	getFn           func(ctx context.Context, userID int64, id string) (services.ImportJob, error)
	retryFn         func(ctx context.Context, userID int64, id string) (services.ImportJob, error)
}

func (m *mockGitHubImportRouteService) StartImport(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error) {
	return m.startFn(ctx, input)
}

func (m *mockGitHubImportRouteService) StartTemplateImport(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error) {
	return m.startTemplateFn(ctx, input)
}

func (m *mockGitHubImportRouteService) GetImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	return m.getFn(ctx, userID, id)
}

func (m *mockGitHubImportRouteService) RetryImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	return m.retryFn(ctx, userID, id)
}

func TestGitHubImportHandler_StartTemplateImport_ReturnsCloningJob(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		startTemplateFn: func(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error) {
			assert.Equal(t, int64(7), input.UserID)
			assert.Equal(t, "vite-react", input.TemplateID)
			assert.Equal(t, "my-app", input.Name)
			return services.ImportJob{ImportJobID: "job-template", RepoOwner: "alice", RepoName: "my-app", TargetBookmark: "main", Status: "cloning", Stage: "resolving"}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/from-template", strings.NewReader(`{"template_id":"vite-react","name":"my-app"}`))
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.StartTemplateImport(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.JSONEq(t, `{"importJobId":"job-template","repoOwner":"alice","repoName":"my-app","target_bookmark":"main","status":"cloning","stage":"resolving","counts":{"refs":{"done":0,"total":0},"objects":{"done":0,"total":0},"issues":{"done":0,"total":0}},"created_at":"0001-01-01T00:00:00Z","updated_at":"0001-01-01T00:00:00Z"}`, rec.Body.String())
}

func TestGitHubImportHandler_StartTemplateImport_RequiresAuth(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/from-template", strings.NewReader(`{"template_id":"vite-react","name":"my-app"}`))
	rec := httptest.NewRecorder()

	handler.StartTemplateImport(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGitHubImportHandler_StartTemplateImport_UsesStandardServiceErrors(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		serviceErr error
		wantStatus int
	}{
		{name: "unknown template", body: `{"template_id":"unknown","name":"my-app"}`, serviceErr: pkgerrors.NotFound("template not found"), wantStatus: http.StatusNotFound},
		{name: "invalid name", body: `{"template_id":"vite-react","name":"bad name"}`, serviceErr: pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Repository", Field: "name", Code: "invalid"}), wantStatus: http.StatusUnprocessableEntity},
		{name: "name collision", body: `{"template_id":"vite-react","name":"taken"}`, serviceErr: pkgerrors.Conflict("repository 'taken' already exists"), wantStatus: http.StatusConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
				startTemplateFn: func(context.Context, services.ImportTemplateRepoInput) (services.ImportJob, error) {
					return services.ImportJob{}, tt.serviceErr
				},
			}}
			req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/from-template", strings.NewReader(tt.body)), 7, "alice")
			rec := httptest.NewRecorder()

			handler.StartTemplateImport(rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestGitHubImportHandler_StartImport_ReturnsCloningJob(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		startFn: func(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error) {
			assert.Equal(t, int64(7), input.UserID)
			assert.Equal(t, "octo", input.Owner)
			assert.Equal(t, "demo", input.Repo)
			assert.Equal(t, "landing/demo-123", input.Branch)
			return services.ImportJob{ImportJobID: "job-1", RepoOwner: "octo", RepoName: "demo", TargetBookmark: "landing/demo-123", Status: "cloning"}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/github/import", strings.NewReader(`{"owner":"octo","repo":"demo","branch":"landing/demo-123"}`))
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.StartImport(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.JSONEq(t, `{"importJobId":"job-1","repoOwner":"octo","repoName":"demo","target_bookmark":"landing/demo-123","status":"cloning","stage":"","counts":{"refs":{"done":0,"total":0},"objects":{"done":0,"total":0},"issues":{"done":0,"total":0}},"created_at":"0001-01-01T00:00:00Z","updated_at":"0001-01-01T00:00:00Z"}`, rec.Body.String())
}

func TestGitHubImportHandler_GetImportJob(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		getFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "job-1", id)
			return services.ImportJob{
				ImportJobID: "job-1", RepoOwner: "alice", RepoName: "demo", Status: "ready",
				Counts: services.ImportJobCounts{
					Refs: services.ImportJobCount{Done: 12, Total: 12}, Objects: services.ImportJobCount{Done: 420, Total: 420},
					Issues: services.ImportJobCount{Done: 0, Total: 0},
				},
				Repository:  &services.ImportJobRepository{Owner: "alice", Name: "demo"},
				WorkspaceID: "11111111-1111-4111-8111-111111111111",
			}, nil
		},
	}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", func(w http.ResponseWriter, r *http.Request) {
		r = withAuth(r, 7, "alice")
		handler.GetImportJob(w, r)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"status":"ready"`)
	assert.Contains(t, rec.Body.String(), `"counts":{"refs":{"done":12,"total":12},"objects":{"done":420,"total":420},"issues":{"done":0,"total":0}}`)
	assert.Contains(t, rec.Body.String(), `"repository":{"owner":"alice","name":"demo"}`)
	assert.Contains(t, rec.Body.String(), `"workspace_id":"11111111-1111-4111-8111-111111111111"`)
}

func TestGitHubImportHandler_RetryImportJob(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		retryFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "job-1", id)
			return services.ImportJob{ImportJobID: id, Status: "cloning", Stage: "importing_refs"}, nil
		},
	}}
	router := chi.NewRouter()
	router.Post("/api/github/import/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		handler.RetryImportJob(w, withAuth(r, 7, "alice"))
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/github/import/job-1/retry", nil))

	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Contains(t, rec.Body.String(), `"status":"cloning"`)
	assert.Contains(t, rec.Body.String(), `"stage":"importing_refs"`)
}

func TestGitHubImportHandler_GetImportJobReturnsFailureVerbatim(t *testing.T) {
	const failure = "GitHub API: 422 label 'infra' does not exist\nretry after fixing it"
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		getFn: func(context.Context, int64, string) (services.ImportJob, error) {
			return services.ImportJob{ImportJobID: "job-1", Status: "failed", Error: failure}, nil
		},
	}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", func(w http.ResponseWriter, r *http.Request) {
		handler.GetImportJob(w, withAuth(r, 7, "alice"))
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, failure, body.Error)
}

func TestGitHubImportHandler_RetryImportJobRequiresAuthAndPropagatesConflict(t *testing.T) {
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		retryFn: func(context.Context, int64, string) (services.ImportJob, error) {
			return services.ImportJob{}, pkgerrors.Conflict("only failed import jobs can be retried")
		},
	}}

	unauthorized := httptest.NewRecorder()
	handler.RetryImportJob(unauthorized, httptest.NewRequest(http.MethodPost, "/api/github/import/job-1/retry", nil))
	require.Equal(t, http.StatusUnauthorized, unauthorized.Code)

	router := chi.NewRouter()
	router.Post("/api/github/import/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		handler.RetryImportJob(w, withAuth(r, 7, "alice"))
	})
	conflict := httptest.NewRecorder()
	router.ServeHTTP(conflict, httptest.NewRequest(http.MethodPost, "/api/github/import/job-1/retry", nil))
	require.Equal(t, http.StatusConflict, conflict.Code)
}

func TestGitHubImportHandler_GetImportJobStreamsSSE(t *testing.T) {
	oldPollInterval := githubImportStreamPollInterval
	githubImportStreamPollInterval = time.Millisecond
	t.Cleanup(func() {
		githubImportStreamPollInterval = oldPollInterval
	})

	calls := 0
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		getFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, "job-1", id)
			calls++
			status := "cloning"
			if calls > 1 {
				status = "ready"
			}
			return services.ImportJob{ImportJobID: "job-1", RepoOwner: "octo", RepoName: "demo", Status: status}, nil
		},
	}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", func(w http.ResponseWriter, r *http.Request) {
		r = withAuth(r, 7, "alice")
		handler.GetImportJob(w, r)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
	req.Header.Set("Accept", "text/event-stream, application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/event-stream")
	assert.GreaterOrEqual(t, calls, 2)
	body := rec.Body.String()
	assert.Contains(t, body, "event: import_job")
	assert.Contains(t, body, `"status":"cloning"`)
	assert.Contains(t, body, `"status":"ready"`)
}

func TestGitHubImportHandler_GetImportJobStreamsServiceErrorFrame(t *testing.T) {
	oldPollInterval := githubImportStreamPollInterval
	githubImportStreamPollInterval = time.Millisecond
	t.Cleanup(func() {
		githubImportStreamPollInterval = oldPollInterval
	})

	calls := 0
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		getFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			calls++
			if calls > 1 {
				return services.ImportJob{}, errors.New("database unavailable")
			}
			return services.ImportJob{ImportJobID: "job-1", RepoOwner: "octo", RepoName: "demo", Status: "cloning"}, nil
		},
	}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", func(w http.ResponseWriter, r *http.Request) {
		r = withAuth(r, 7, "alice")
		handler.GetImportJob(w, r)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "event: error")
	assert.Contains(t, rec.Body.String(), "failed to fetch import job status")
}

func TestGitHubImportHandler_GetImportJobStreamsTimeoutFrame(t *testing.T) {
	oldPollInterval := githubImportStreamPollInterval
	oldMaxDuration := githubImportStreamMaxDuration
	githubImportStreamPollInterval = time.Hour
	githubImportStreamMaxDuration = time.Millisecond
	t.Cleanup(func() {
		githubImportStreamPollInterval = oldPollInterval
		githubImportStreamMaxDuration = oldMaxDuration
	})

	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{
		getFn: func(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
			return services.ImportJob{ImportJobID: "job-1", RepoOwner: "octo", RepoName: "demo", Status: "cloning"}, nil
		},
	}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", func(w http.ResponseWriter, r *http.Request) {
		r = withAuth(r, 7, "alice")
		handler.GetImportJob(w, r)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "event: timeout")
	assert.Contains(t, rec.Body.String(), "stream timed out")
}
