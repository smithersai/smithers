package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type gitMirrorSyncCovService struct {
	startErr  error
	getErr    error
	called    bool
	userID    int64
	repoID    int64
	owner     string
	repo      string
	runID     int64
	getResult services.GitMirrorSyncRunResult
	reconcile services.GitHubReconcileResult
	retryRef  string
}

func TestGitMirrorSync_RetryRouteAcceptsEscapedFullRef(t *testing.T) {
	svc := &gitMirrorSyncCovService{runID: 90}
	handler := &GitMirrorSyncHandler{Service: svc}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = withRepoContext(withAuth(r, 7, "alice"), "alice", "demo")
			next.ServeHTTP(w, r)
		})
	})
	router.Post("/api/repos/{owner}/{repo}/github/mirror/refs/{ref}/retry", handler.RetryMirrorRef)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/mirror/refs/refs%2Fheads%2Fmain/retry", nil))

	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, "refs/heads/main", svc.retryRef)
}

func (s *gitMirrorSyncCovService) StartMirrorSync(ctx context.Context, userID, repositoryID int64, owner, repo string) (int64, error) {
	s.called = true
	s.userID = userID
	s.repoID = repositoryID
	s.owner = owner
	s.repo = repo
	return s.runID, s.startErr
}

func (s *gitMirrorSyncCovService) StartGitHubReconcile(ctx context.Context, userID, repositoryID int64, owner, repo string) (services.GitHubReconcileResult, error) {
	s.called = true
	s.userID = userID
	s.repoID = repositoryID
	s.owner = owner
	s.repo = repo
	return s.reconcile, s.startErr
}

func (s *gitMirrorSyncCovService) GetMirrorSyncRun(ctx context.Context, repositoryID, runID int64) (services.GitMirrorSyncRunResult, error) {
	s.called = true
	s.repoID = repositoryID
	s.runID = runID
	return s.getResult, s.getErr
}

func (s *gitMirrorSyncCovService) RetryMirrorRef(_ context.Context, userID, repositoryID int64, owner, repo, ref string) (int64, error) {
	s.called = true
	s.userID = userID
	s.repoID = repositoryID
	s.owner = owner
	s.repo = repo
	s.retryRef = ref
	return s.runID, s.startErr
}

func TestGitMirrorSync_Cov_HandlerBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires configured service", func(t *testing.T) {
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil), 7, "alice"), "alice", "demo")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{}).MirrorSync(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "service not configured")
	})

	t.Run("route param error prevents service call", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{}
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).MirrorSync(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.False(t, svc.called)
	})

	t.Run("success returns run id", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{runID: 88}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil), 7, "alice"), "alice", "demo")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).MirrorSync(rec, req)

		require.Equal(t, http.StatusAccepted, rec.Code)
		assert.True(t, svc.called)
		assert.Equal(t, int64(7), svc.userID)
		assert.Equal(t, int64(101), svc.repoID)
		assert.Equal(t, "alice", svc.owner)
		var body GitMirrorSyncResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, int64(88), body.RunID)
	})

	t.Run("service api error propagates", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{startErr: pkgerrors.Forbidden("mirror denied")}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil), 7, "alice"), "alice", "demo")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).MirrorSync(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "mirror denied")
	})

	t.Run("github reconcile returns the pollable run", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{reconcile: services.GitHubReconcileResult{
			RunID: 88,
			GitMirrorSyncRunResult: services.GitMirrorSyncRunResult{
				ID: 88, State: "queued", Refs: []services.GitMirrorSyncRefResult{},
			},
		}}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/reconcile", nil), 7, "alice"), "alice", "demo")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).ReconcileGitHub(rec, req)

		require.Equal(t, http.StatusAccepted, rec.Code)
		assert.True(t, svc.called)
		assert.Equal(t, int64(7), svc.userID)
		assert.Equal(t, int64(101), svc.repoID)
		assert.Equal(t, "alice", svc.owner)
		assert.Equal(t, "demo", svc.repo)
		assert.JSONEq(t, `{
			"run_id": 88,
			"id": 88,
			"state": "queued",
			"behind_refs": 0,
			"failed_refs": 0,
			"started_at": null,
			"finished_at": null,
			"refs": []
		}`, rec.Body.String())
	})

	t.Run("github reconcile propagates active run conflict", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{startErr: pkgerrors.Conflict("git mirror sync already running")}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/reconcile", nil), 7, "alice"), "alice", "demo")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).ReconcileGitHub(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "already running")
	})

	t.Run("get returns the pollable run", func(t *testing.T) {
		started := time.Unix(100, 0).UTC()
		finished := time.Unix(200, 0).UTC()
		svc := &gitMirrorSyncCovService{getResult: services.GitMirrorSyncRunResult{
			ID: 88, State: "succeeded", StartedAt: &started, FinishedAt: &finished,
			BehindRefs: 2, FailedRefs: 1,
			Refs: []services.GitMirrorSyncRefResult{{Name: "refs/heads/main", From: "old", To: "new", Status: "succeeded", Error: ""}},
		}}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/mirror-sync/88", nil), 7, "alice"), "alice", "demo")
		req = withRouteParams(req, map[string]string{"run_id": "88"})
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{Service: svc}).GetMirrorSyncRun(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, int64(101), svc.repoID)
		assert.Equal(t, int64(88), svc.runID)
		var body services.GitMirrorSyncRunResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "succeeded", body.State)
		assert.Equal(t, int64(88), body.ID)
		require.Len(t, body.Refs, 1)
		assert.Equal(t, "old", body.Refs[0].From)
		assert.Equal(t, 2, body.BehindRefs)
		assert.Equal(t, 1, body.FailedRefs)
	})

	t.Run("retry passes the decoded ref and returns a run id", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{runID: 89}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/mirror/refs/refs%2Fheads%2Fmain/retry", nil), 7, "alice"), "alice", "demo")
		req = withRouteParams(req, map[string]string{"ref": "refs%2Fheads%2Fmain"})
		rec := httptest.NewRecorder()
		(&GitMirrorSyncHandler{Service: svc}).RetryMirrorRef(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
		assert.Equal(t, "refs/heads/main", svc.retryRef)
		assert.JSONEq(t, `{"run_id":89}`, rec.Body.String())
	})

	t.Run("get rejects an invalid run id", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/mirror-sync/nope", nil), 7, "alice"), "alice", "demo")
		req = withRouteParams(req, map[string]string{"run_id": "nope"})
		rec := httptest.NewRecorder()
		(&GitMirrorSyncHandler{Service: svc}).GetMirrorSyncRun(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, svc.called)
	})

	t.Run("get service error propagates", func(t *testing.T) {
		svc := &gitMirrorSyncCovService{getErr: pkgerrors.NotFound("mirror sync run not found")}
		req := withRepoContext(withAuth(httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/mirror-sync/88", nil), 7, "alice"), "alice", "demo")
		req = withRouteParams(req, map[string]string{"run_id": "88"})
		rec := httptest.NewRecorder()
		(&GitMirrorSyncHandler{Service: svc}).GetMirrorSyncRun(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}
