package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStacks_H_RemainingGuardBranches(t *testing.T) {
	h := &StackHandler{Service: &mockStackRouteService{}}

	t.Run("get missing repo param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice//stacks/active", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.GetActiveStack(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("upsert requires auth", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/stacks/active", strings.NewReader(`{"target_ref":"main"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.UpsertActiveStack(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("upsert missing owner param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos//demo/stacks/active", strings.NewReader(`{"target_ref":"main"}`))
		req = withRouteParams(req, map[string]string{"repo": "demo"})
		req = withAuth(req, 42, "alice")
		rec := httptest.NewRecorder()

		h.UpsertActiveStack(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires auth", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/stacks/active", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.DeleteActiveStack(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}
