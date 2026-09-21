package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCommitStatus_H_RemainingGuardBranches(t *testing.T) {
	h := &CommitStatusHandler{Service: &mockCommitStatusRouteService{}}

	t.Run("get missing repo context", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/main/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "main"})
		rec := httptest.NewRecorder()

		h.GetCommitStatuses(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("get missing ref param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits//statuses", nil)
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()

		h.GetCommitStatuses(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get rejects invalid ref", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/bad/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "bad\x00ref"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()

		h.GetCommitStatuses(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("create missing repo context", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(`{"state":"success"}`))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateCommitStatus(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
