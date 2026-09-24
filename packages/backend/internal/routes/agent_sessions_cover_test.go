package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestAgentSessions_Cov_CreateListGetDeleteBranches(t *testing.T) {
	t.Run("nil service returns unavailable for public handlers", func(t *testing.T) {
		h := &AgentSessionHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.CreateSession(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListSessions(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("create validates repository context and json before service call", func(t *testing.T) {
		called := false
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			createSessionFn: func(ctx context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error) {
				called = true
				return services.AgentSessionResponse{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{"title":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.CreateSession(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)

		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()

		h.CreateSession(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.False(t, called)
	})

	t.Run("create and list service errors propagate", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			createSessionFn: func(ctx context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{}, pkgerrors.Forbidden("cannot create session")
			},
			listSessionsFn: func(ctx context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error) {
				return nil, 0, pkgerrors.Forbidden("cannot list sessions")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions", strings.NewReader(`{"title":"x"}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.CreateSession(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions?page=abc", nil)
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListSessions(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListSessions(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("get and delete validate route params and repo context", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions", nil)
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.GetSession(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		req = withAuth(req, 7, "alice")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec = httptest.NewRecorder()
		h.DeleteSession(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get propagates second lookup error after repo scope succeeds", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(ctx context.Context, sessionID string, repoID int64) error {
				return nil
			},
			getSessionFn: func(ctx context.Context, sessionID string) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{}, pkgerrors.NotFound("agent session not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1", nil)
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec := httptest.NewRecorder()

		h.GetSession(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestAgentSessions_Cov_PostMessageBranches(t *testing.T) {
	t.Run("nil service unauthorized route and missing route id", func(t *testing.T) {
		h := &AgentSessionHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess/messages", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		h = &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/messages", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("repo scope and session lookup errors stop before decoding", func(t *testing.T) {
		appendCalled := false
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(ctx context.Context, sessionID string, repoID int64) error {
				return pkgerrors.NotFound("agent session not found")
			},
			appendMessageFn: func(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				appendCalled = true
				return services.AgentMessageResponse{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec := httptest.NewRecorder()

		h.PostMessage(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, appendCalled)

		h = &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			getSessionFn: func(ctx context.Context, sessionID string) (services.AgentSessionResponse, error) {
				return services.AgentSessionResponse{}, pkgerrors.NotFound("agent session not found")
			},
			appendMessageFn: func(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				appendCalled = true
				return services.AgentMessageResponse{}, nil
			},
		}}
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec = httptest.NewRecorder()

		h.PostMessage(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.False(t, appendCalled)
	})

	t.Run("decode normalization and append errors", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{"role":"assistant","parts":[{"type":"tool_call","content":"not-object"}]}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec = httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			appendMessageFn: func(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error) {
				return services.AgentMessageResponse{}, pkgerrors.Conflict("sequence conflict")
			},
		}}
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/agent/sessions/sess-1/messages", strings.NewReader(`{"role":"assistant","parts":[{"type":"text","content":{"value":"ack"}}]}`))
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		rec = httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusConflict, rec.Code)
	})
}

func TestAgentSessions_Cov_ListMessagesAndNormalizationHelpers(t *testing.T) {
	t.Run("list messages validates auth repo pagination and service errors", func(t *testing.T) {
		h := &AgentSessionHandler{Service: &mockAgentSessionRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages", nil)
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		req = withRepoCtx(req, 101, "alice", "demo")
		rec := httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages?page=bad", nil)
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		h = &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			getSessionForRepo: func(ctx context.Context, sessionID string, repoID int64) error {
				return pkgerrors.NotFound("agent session not found")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages", nil)
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)

		h = &AgentSessionHandler{Service: &mockAgentSessionRouteService{
			listMessagesFn: func(ctx context.Context, sessionID string, page, perPage int) ([]services.AgentMessageResponse, error) {
				return nil, pkgerrors.Forbidden("cannot read messages")
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/sess-1/messages", nil)
		req = withRouteParams(req, map[string]string{"id": "sess-1"})
		req = withAuth(req, 7, "alice")
		req = withRepoCtx(req, 101, "alice", "demo")
		rec = httptest.NewRecorder()
		h.ListMessages(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("runtime request defaults and rejects invalid combinations", func(t *testing.T) {
		provider, transport, apiErr := normalizeAgentRuntimeRequest("", "")
		require.Nil(t, apiErr)
		assert.Equal(t, "smithers", provider)
		assert.Equal(t, "workflow", transport)

		_, _, apiErr = normalizeAgentRuntimeRequest("bad", "workflow")
		require.Error(t, apiErr)
		_, _, apiErr = normalizeAgentRuntimeRequest("codex", "bad")
		require.Error(t, apiErr)
	})

	t.Run("message request normalization rejects missing parts and non-object content", func(t *testing.T) {
		_, _, apiErr := normalizeCreateAgentMessageRequest(createAgentMessageRequest{Role: "assistant"})
		require.Error(t, apiErr)

		_, apiErr = normalizeAgentMessageParts([]createAgentMessagePartRequest{{Type: "text", Content: json.RawMessage(``)}})
		require.Error(t, apiErr)

		_, err := normalizeAgentMessagePartContent("tool_result", json.RawMessage(`["array"]`))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "part content must be an object")

		normalized, err := normalizeAgentMessagePartContent("tool_result", json.RawMessage(`{"ok":true}`))
		require.NoError(t, err)
		assert.JSONEq(t, `{"ok":true}`, string(normalized))
	})
}
