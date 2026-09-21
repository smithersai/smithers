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
)

func TestRepoSync_Cov_MissingServiceAndDecodeBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires configured service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/sync", strings.NewReader(`{}`)), 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		(&RepoHandler{}).SyncRepo(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "repo sync service not configured")
	})

	t.Run("invalid json prevents service call", func(t *testing.T) {
		called := false
		h := &RepoHandler{RepoSyncService: &mockRepoSyncRouteService{
			syncFn: func(context.Context, int64, string, string, services.RepoSyncRequest) error {
				called = true
				return nil
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/sync", strings.NewReader(`{bad`)), 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.SyncRepo(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("missing repo route param returns bad request", func(t *testing.T) {
		h := &RepoHandler{RepoSyncService: &mockRepoSyncRouteService{}}
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice//sync", strings.NewReader(`{}`)), 7, "alice")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": ""})
		rec := httptest.NewRecorder()

		h.SyncRepo(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "repository name is required")
	})
}
