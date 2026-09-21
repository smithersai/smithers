package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestAgentSessions_F_GuardBranches drives the service-nil, missing-auth,
// missing route-param and missing repo-context guards across the agent session
// handlers.
func TestAgentSessions_F_GuardBranches(t *testing.T) {
	idParam := map[string]string{"id": "sess-1"}

	t.Run("CreateSession requires auth", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{}`))
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.CreateSession(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("ListSessions requires auth", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
		rec := httptest.NewRecorder()
		h.ListSessions(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("ListSessions requires repo context", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.ListSessions(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("GetSession service unavailable", func(t *testing.T) {
		h := &AgentSessionHandler{}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		rec := httptest.NewRecorder()
		h.GetSession(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("GetSession requires auth", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		rec := httptest.NewRecorder()
		h.GetSession(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("GetSession requires repo context", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		req = withRouteParams(req, idParam)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.GetSession(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteSession service unavailable", func(t *testing.T) {
		h := &AgentSessionHandler{}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		rec := httptest.NewRecorder()
		h.DeleteSession(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("DeleteSession requires auth", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		rec := httptest.NewRecorder()
		h.DeleteSession(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("DeleteSession missing id param", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteSession(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("PostMessage requires auth", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("PostMessage requires repo context", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{}`))
		req = withRouteParams(req, idParam)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListMessages service unavailable", func(t *testing.T) {
		h := &AgentSessionHandler{}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages", nil)
		rec := httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("ListMessages missing id param", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions//messages", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListMessages requires repo context", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages", nil)
		req = withRouteParams(req, idParam)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

// TestAgentSessions_F_MustMarshalPanicsOnUnmarshalable exercises the panic path
// of mustMarshalAgentJSON, whose error branch is unreachable through the public
// handlers (all callers pass strings / json.Unmarshal output).
func TestAgentSessions_F_MustMarshalPanicsOnUnmarshalable(t *testing.T) {
	require.Panics(t, func() {
		mustMarshalAgentJSON(make(chan int))
	})
}
