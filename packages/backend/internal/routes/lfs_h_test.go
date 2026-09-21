package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLFS_H_ConfirmAndDeleteGuardBranches(t *testing.T) {
	h := LFSHandler{Service: &mockLFSRouteService{}}

	t.Run("confirm missing repo param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice//lfs/confirm", strings.NewReader(`{"oid":"a","size":1}`))
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostConfirm(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires auth", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/lfs/objects/a", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "oid": "a"})
		rec := httptest.NewRecorder()

		h.DeleteObject(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete missing repo param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice//lfs/objects/a", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "oid": "a"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.DeleteObject(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
