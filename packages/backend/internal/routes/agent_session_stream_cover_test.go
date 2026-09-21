package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type agentSessionStreamCovService struct {
	getErr   error
	listErr  error
	messages []services.AgentMessageResponse
	called   bool
}

func (s *agentSessionStreamCovService) GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error {
	return s.getErr
}

func (s *agentSessionStreamCovService) ListMessagesAfterID(ctx context.Context, sessionID string, afterID int64, limit int) ([]services.AgentMessageResponse, error) {
	s.called = true
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.messages, nil
}

func TestAgentSessionStream_Cov_ReplayBranches(t *testing.T) {
	t.Parallel()

	t.Run("nil service returns without writing", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		req.Header.Set("Last-Event-ID", "10")
		rec := httptest.NewRecorder()

		(&AgentSessionStreamHandler{}).replayAgentSessionEvents(rec, req, rec, "session-1")

		assert.Empty(t, rec.Body.String())
		assert.False(t, rec.Flushed)
	})

	t.Run("service error emits retryable replay failure", func(t *testing.T) {
		svc := &agentSessionStreamCovService{listErr: pkgerrors.Internal("db down")}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		req.Header.Set("Last-Event-ID", "11")
		rec := httptest.NewRecorder()

		(&AgentSessionStreamHandler{Service: svc}).replayAgentSessionEvents(rec, req, rec, "session-1")

		assert.True(t, svc.called)
		assert.Contains(t, rec.Body.String(), "event: stream.error")
		assert.NotContains(t, rec.Body.String(), "id:")
		assert.True(t, rec.Flushed)
	})

	t.Run("empty result does not flush", func(t *testing.T) {
		svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{}}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		req.Header.Set("Last-Event-ID", "12")
		rec := httptest.NewRecorder()

		(&AgentSessionStreamHandler{Service: svc}).replayAgentSessionEvents(rec, req, rec, "session-1")

		assert.True(t, svc.called)
		assert.Empty(t, rec.Body.String())
		assert.False(t, rec.Flushed)
	})

	t.Run("positive last event id writes formatted event", func(t *testing.T) {
		svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{{
			ID:        13,
			SessionID: "session-1",
			Role:      "assistant",
			Sequence:  2,
			CreatedAt: time.Date(2026, 7, 7, 1, 2, 3, 0, time.UTC),
		}}}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		req.Header.Set("Last-Event-ID", "12")
		rec := httptest.NewRecorder()

		(&AgentSessionStreamHandler{Service: svc}).replayAgentSessionEvents(rec, req, rec, "session-1")

		require.True(t, svc.called)
		assert.True(t, rec.Flushed)
		assert.Contains(t, rec.Body.String(), "id: 13\n")
		assert.Contains(t, rec.Body.String(), "event: agent.session\n")
		assert.Contains(t, rec.Body.String(), `"action":"message"`)
	})
}

func (m *agentSessionStreamCovService) GetAgentMessageStreamHead(context.Context, string) (int64, error) {
	return 0, nil
}
