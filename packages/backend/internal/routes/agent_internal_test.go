package routes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// mockAgentInternalService implements AgentInternalRouteService for tests.
type mockAgentInternalService struct {
	ingestRunnerEventFn func(ctx context.Context, input services.IngestRunnerEventInput) error
	lastInput           *services.IngestRunnerEventInput
}

func (m *mockAgentInternalService) IngestRunnerEvent(ctx context.Context, input services.IngestRunnerEventInput) error {
	m.lastInput = &input
	if m.ingestRunnerEventFn != nil {
		return m.ingestRunnerEventFn(ctx, input)
	}
	return nil
}

// mockAgentTokenQuerier implements AgentTokenQuerier for tests.
type mockAgentTokenQuerier struct {
	getWorkflowRunByAgentTokenFn   func(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error)
	getAgentSessionWorkflowRunIDFn func(ctx context.Context, id string) (pgtype.Int8, error)
	getWorkflowTaskByRunIDFn       func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
}

func (m *mockAgentTokenQuerier) GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error) {
	if m.getWorkflowRunByAgentTokenFn != nil {
		return m.getWorkflowRunByAgentTokenFn(ctx, agentTokenHash)
	}
	return db.WorkflowRun{ID: 1}, nil
}

func (m *mockAgentTokenQuerier) GetAgentSessionWorkflowRunID(ctx context.Context, id string) (pgtype.Int8, error) {
	if m.getAgentSessionWorkflowRunIDFn != nil {
		return m.getAgentSessionWorkflowRunIDFn(ctx, id)
	}
	return pgtype.Int8{Int64: 1, Valid: true}, nil
}

func (m *mockAgentTokenQuerier) GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
	if m.getWorkflowTaskByRunIDFn != nil {
		return m.getWorkflowTaskByRunIDFn(ctx, workflowRunID)
	}
	// Default: return an active (running) task so existing tests pass unchanged.
	return db.WorkflowTask{ID: 1, WorkflowRunID: workflowRunID, Status: "running"}, nil
}

// buildValidToken generates a plaintext token and returns both the plaintext and its SHA-256 hash.
func buildValidToken(plaintext string) (string, string) {
	sum := sha256.Sum256([]byte(plaintext))
	hash := hex.EncodeToString(sum[:])
	return plaintext, hash
}

// newValidTokenQuerier returns a TokenQuerier that accepts the given plaintext token for sessionID.
func newValidTokenQuerier(plaintext string, sessionID string, runID int64) *mockAgentTokenQuerier {
	_, tokenHash := buildValidToken(plaintext)
	return &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			if id == sessionID {
				return pgtype.Int8{Int64: runID, Valid: true}, nil
			}
			return pgtype.Int8{Valid: false}, errors.New("session not found")
		},
	}
}

func newAgentInternalRequest(method, path string, body any) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func withChiURLParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// addBearerAuth adds an Authorization: Bearer header to the request.
func addBearerAuth(req *http.Request, token string) *http.Request {
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func TestAgentInternalHandler_PostSessionEvent_Success(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-123"
	const runID = int64(42)
	const token = "smithers_agent_testtoken12345678901234567890"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello from agent"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)
	assert.NotNil(t, svc.lastInput)
	assert.Equal(t, sessionID, svc.lastInput.SessionID)
	assert.Equal(t, "text", svc.lastInput.EventType)
}

func TestAgentInternalHandler_PostSessionEvent_ToolCall(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-456"
	const runID = int64(43)
	const token = "smithers_agent_toolcalltest12345678901234567"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "tool_call",
		Content:   json.RawMessage(`{"name":"read_file","input":{"path":"main.go"}}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-456/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)
	assert.Equal(t, "tool_call", svc.lastInput.EventType)
}

func TestAgentInternalHandler_PostSessionEvent_DoneEvent(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-789"
	const runID = int64(44)
	const token = "smithers_agent_doneevent123456789012345678"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-789/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)
	assert.Equal(t, "done", svc.lastInput.EventType)
}

func TestAgentInternalHandler_PostSessionEvent_MissingSessionID(t *testing.T) {
	t.Parallel()

	svc := &mockAgentInternalService{}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: &mockAgentTokenQuerier{}}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions//events", body)
	req = withChiURLParam(req, "session_id", "")
	req = addBearerAuth(req, "smithers_agent_sometoken")
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_MissingEventType(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-123"
	const runID = int64(45)
	const token = "smithers_agent_missingeventtypetest1234567"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		Content: json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_InvalidBody(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-123"
	const runID = int64(46)
	const token = "smithers_agent_invalidbodytest123456789012"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	req := httptest.NewRequest("POST", "/internal/agent/sessions/sess-123/events", bytes.NewBufferString("not json"))
	req.Header.Set("Content-Type", "application/json")
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_ServiceError(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-123"
	const runID = int64(47)
	const token = "smithers_agent_serviceerrortest12345678901"

	svc := &mockAgentInternalService{
		ingestRunnerEventFn: func(ctx context.Context, input services.IngestRunnerEventInput) error {
			return errors.New("service error")
		},
	}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_NilService(t *testing.T) {
	t.Parallel()

	handler := &AgentInternalHandler{Service: nil}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", "sess-123")
	req = addBearerAuth(req, "smithers_agent_sometoken")
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_ContentPassedThrough(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-abc"
	const runID = int64(48)
	const token = "smithers_agent_contentpassthrough123456789"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	content := json.RawMessage(`{"name":"shell","output":{"exitCode":0,"stdout":"ok"}}`)
	body := postSessionEventRequest{
		EventType: "tool_result",
		Content:   content,
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-abc/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)

	// Verify content was passed through correctly
	var gotContent map[string]any
	assert.NoError(t, json.Unmarshal(svc.lastInput.Content, &gotContent))
	assert.Equal(t, "shell", gotContent["name"])
}

// ---- Auth Tests ----

func TestAgentInternalHandler_PostSessionEvent_MissingAuthHeader_Returns401(t *testing.T) {
	t.Parallel()

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", "sess-123")
	// No Authorization header
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_InvalidToken_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-123"
	const runID = int64(49)
	const validToken = "smithers_agent_validtoken12345678901234567"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(validToken, sessionID, runID)
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, "smithers_agent_wrongtoken12345678901234567") // Wrong token
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_ExpiredToken_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-expired"
	const runID = int64(50)
	const token = "smithers_agent_expiredtoken12345678901234"

	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					// Token expired 1 hour ago
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(-1 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: runID, Valid: true}, nil
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-expired/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TokenNotScopedToSession_Returns401(t *testing.T) {
	t.Parallel()

	const token = "smithers_agent_scopedtest1234567890123456"
	const runID = int64(51)
	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			// Returns a DIFFERENT run ID — token is for a different session
			return pgtype.Int8{Int64: runID + 999, Valid: true}, nil
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/wrong-session/events", body)
	req = withChiURLParam(req, "session_id", "wrong-session")
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_NilTokenQuerier_Returns401(t *testing.T) {
	t.Parallel()

	svc := &mockAgentInternalService{}
	// TokenQuerier is nil — fail closed for security
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: nil}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", "sess-123")
	req = addBearerAuth(req, "smithers_agent_sometoken")
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_NonBearerAuth_Returns401(t *testing.T) {
	t.Parallel()

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-123/events", body)
	req = withChiURLParam(req, "session_id", "sess-123")
	// Use token (not Bearer) scheme
	req.Header.Set("Authorization", "token smithers_agent_sometoken")
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// ---- Task Status Scope Tests ----

func TestAgentInternalHandler_PostSessionEvent_TaskFailed_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-failed-task"
	const runID = int64(60)
	const token = "smithers_agent_failedtasktest1234567890123"

	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: runID, Valid: true}, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			// Task has already failed — token must be rejected.
			return db.WorkflowTask{ID: 10, WorkflowRunID: workflowRunID, Status: "failed"}, nil
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-failed-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TaskDone_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-done-task"
	const runID = int64(61)
	const token = "smithers_agent_donetasktest12345678901234"

	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: runID, Valid: true}, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			// Task has completed — token must be rejected.
			return db.WorkflowTask{ID: 11, WorkflowRunID: workflowRunID, Status: "done"}, nil
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-done-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TaskCancelled_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-cancelled-task"
	const runID = int64(62)
	const token = "smithers_agent_cancelledtasktest123456789"

	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: runID, Valid: true}, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			// Task was cancelled — token must be rejected.
			return db.WorkflowTask{ID: 12, WorkflowRunID: workflowRunID, Status: "cancelled"}, nil
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-cancelled-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TaskRunning_Allows(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-running-task"
	const runID = int64(63)
	const token = "smithers_agent_runningtasktest12345678901"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	// Override getWorkflowTaskByRunIDFn to explicitly return "running" status.
	tq.getWorkflowTaskByRunIDFn = func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
		return db.WorkflowTask{ID: 13, WorkflowRunID: workflowRunID, Status: "running"}, nil
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"running task event"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-running-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TaskPending_Allows(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-pending-task"
	const runID = int64(64)
	const token = "smithers_agent_pendingtasktest1234567890"

	svc := &mockAgentInternalService{}
	tq := newValidTokenQuerier(token, sessionID, runID)
	// Override to explicitly return "pending" status.
	tq.getWorkflowTaskByRunIDFn = func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
		return db.WorkflowTask{ID: 14, WorkflowRunID: workflowRunID, Status: "pending"}, nil
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"pending task event"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-pending-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusAccepted, w.Code)
}

func TestAgentInternalHandler_PostSessionEvent_TaskNotFound_Returns401(t *testing.T) {
	t.Parallel()

	const sessionID = "sess-no-task"
	const runID = int64(65)
	const token = "smithers_agent_notasktest123456789012345"

	_, tokenHash := buildValidToken(token)

	svc := &mockAgentInternalService{}
	tq := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, h pgtype.Text) (db.WorkflowRun, error) {
			if h.String == tokenHash {
				return db.WorkflowRun{
					ID: runID,
					AgentTokenExpiresAt: pgtype.Timestamptz{
						Time:  time.Now().Add(24 * time.Hour),
						Valid: true,
					},
				}, nil
			}
			return db.WorkflowRun{}, errors.New("not found")
		},
		getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: runID, Valid: true}, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			// No task exists for this run — deny access.
			return db.WorkflowTask{}, errors.New("task not found")
		},
	}
	handler := &AgentInternalHandler{Service: svc, TokenQuerier: tq}

	body := postSessionEventRequest{
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	}

	req := newAgentInternalRequest("POST", "/internal/agent/sessions/sess-no-task/events", body)
	req = withChiURLParam(req, "session_id", sessionID)
	req = addBearerAuth(req, token)
	w := httptest.NewRecorder()

	handler.PostSessionEvent(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
