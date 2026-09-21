package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGitMirrorSync_H_GuardBranches(t *testing.T) {
	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{}).MirrorSync(rec, httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("requires service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/mirror-sync", nil), 7, "alice")
		rec := httptest.NewRecorder()

		(&GitMirrorSyncHandler{}).MirrorSync(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("get requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&GitMirrorSyncHandler{}).GetMirrorSyncRun(rec, httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/mirror-sync/1", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("github reconcile requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&GitMirrorSyncHandler{}).ReconcileGitHub(rec, httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/github/reconcile", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}
