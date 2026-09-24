package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAgentInternal_H_ValidateAndPostBranches(t *testing.T) {
	t.Run("unknown session rejects token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", nil)
		req.Header.Set("Authorization", "Bearer token")
		q := &agentInternalCovTokenQuerier{
			run: db.WorkflowRun{
				ID:                  77,
				AgentTokenExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
			},
			sessionErr: pgx.ErrNoRows,
		}

		err := (&AgentInternalHandler{TokenQuerier: q}).validateAgentToken(req.Context(), req, "s")

		requireAPIErrorWithMessage(t, err, http.StatusUnauthorized, "session not found")
	})

	t.Run("post missing session id", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions//events", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"session_id": ""})
		rec := httptest.NewRecorder()

		(&AgentInternalHandler{Service: &agentInternalCovService{}}).PostSessionEvent(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post wraps non api validation errors", func(t *testing.T) {
		h := &AgentInternalHandler{
			Service: &agentInternalCovService{},
			validateToken: func(context.Context, *http.Request, string) error {
				return errors.New("unexpected validator failure")
			},
		}
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", strings.NewReader(`{"event_type":"text"}`))
		req = withRouteParams(req, map[string]string{"session_id": "s"})
		rec := httptest.NewRecorder()

		h.PostSessionEvent(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Contains(t, rec.Body.String(), "unauthorized")
	})

	t.Run("post invalid json after token validation", func(t *testing.T) {
		h := agentInternalHValidHandler(t)
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", strings.NewReader(`{`))
		req.Header.Set("Authorization", "Bearer token")
		req = withRouteParams(req, map[string]string{"session_id": "s"})
		rec := httptest.NewRecorder()

		h.PostSessionEvent(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post requires event type", func(t *testing.T) {
		h := agentInternalHValidHandler(t)
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", strings.NewReader(`{"content":{}}`))
		req.Header.Set("Authorization", "Bearer token")
		req = withRouteParams(req, map[string]string{"session_id": "s"})
		rec := httptest.NewRecorder()

		h.PostSessionEvent(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "event_type is required")
	})
}

func agentInternalHValidHandler(t *testing.T) *AgentInternalHandler {
	t.Helper()
	return &AgentInternalHandler{
		Service: &agentInternalCovService{},
		TokenQuerier: &agentInternalCovTokenQuerier{
			run: db.WorkflowRun{
				ID:                  9,
				AgentTokenExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
			},
			sessionRunID: pgtype.Int8{Int64: 9, Valid: true},
			task:         db.WorkflowTask{WorkflowRunID: 9, Status: "pending"},
		},
	}
}
