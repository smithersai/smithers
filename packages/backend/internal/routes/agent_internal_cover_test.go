package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type agentInternalCovTokenQuerier struct {
	run          db.WorkflowRun
	sessionRunID pgtype.Int8
	task         db.WorkflowTask
	runErr       error
	sessionErr   error
	taskErr      error
	capturedHash string
}

func (q *agentInternalCovTokenQuerier) GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error) {
	q.capturedHash = agentTokenHash.String
	if q.runErr != nil {
		return db.WorkflowRun{}, q.runErr
	}
	return q.run, nil
}

func (q *agentInternalCovTokenQuerier) GetAgentSessionWorkflowRunID(ctx context.Context, id string) (pgtype.Int8, error) {
	if q.sessionErr != nil {
		return pgtype.Int8{}, q.sessionErr
	}
	return q.sessionRunID, nil
}

func (q *agentInternalCovTokenQuerier) GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
	if q.taskErr != nil {
		return db.WorkflowTask{}, q.taskErr
	}
	return q.task, nil
}

type agentInternalCovService struct {
	err error
	got services.IngestRunnerEventInput
}

func (s *agentInternalCovService) IngestRunnerEvent(ctx context.Context, input services.IngestRunnerEventInput) error {
	s.got = input
	return s.err
}

func TestAgentInternal_Cov_ValidateTokenFailures(t *testing.T) {
	t.Parallel()

	t.Run("missing token querier fails closed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", nil)
		err := (&AgentInternalHandler{}).validateAgentToken(req.Context(), req, "s")
		requireAPIErrorWithMessage(t, err, http.StatusUnauthorized, "agent token validation not configured")
	})

	t.Run("empty bearer token is rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", nil)
		req.Header.Set("Authorization", "Bearer ")
		err := (&AgentInternalHandler{TokenQuerier: &agentInternalCovTokenQuerier{}}).validateAgentToken(req.Context(), req, "s")
		requireAPIErrorWithMessage(t, err, http.StatusUnauthorized, "empty agent token")
	})

	t.Run("terminated task invalidates token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", nil)
		req.Header.Set("Authorization", "Bearer plaintext-token")
		q := &agentInternalCovTokenQuerier{
			run: db.WorkflowRun{
				ID:                  77,
				AgentTokenExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
			},
			sessionRunID: pgtype.Int8{Int64: 77, Valid: true},
			task:         db.WorkflowTask{WorkflowRunID: 77, Status: "completed"},
		}

		err := (&AgentInternalHandler{TokenQuerier: q}).validateAgentToken(req.Context(), req, "s")

		requireAPIErrorWithMessage(t, err, http.StatusUnauthorized, "agent token is no longer valid: task has terminated")
		sum := sha256.Sum256([]byte("plaintext-token"))
		assert.Equal(t, hex.EncodeToString(sum[:]), q.capturedHash)
	})
}

func TestAgentInternal_Cov_PostSessionEventBranches(t *testing.T) {
	t.Parallel()

	t.Run("service unavailable before token validation", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", strings.NewReader(`{}`)), map[string]string{"session_id": "s"})
		rec := httptest.NewRecorder()

		(&AgentInternalHandler{}).PostSessionEvent(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "agent service unavailable")
	})

	t.Run("ingest service error is propagated", func(t *testing.T) {
		svc := &agentInternalCovService{err: pkgerrors.Forbidden("agent cannot write")}
		handler := &AgentInternalHandler{
			Service: svc,
			TokenQuerier: &agentInternalCovTokenQuerier{
				run: db.WorkflowRun{
					ID:                  9,
					AgentTokenExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
				},
				sessionRunID: pgtype.Int8{Int64: 9, Valid: true},
				task:         db.WorkflowTask{WorkflowRunID: 9, Status: "running"},
			},
		}
		body, err := json.Marshal(postSessionEventRequest{EventType: "text", Content: json.RawMessage(`{"text":"hi"}`)})
		require.NoError(t, err)
		req := withRouteParams(httptest.NewRequest(http.MethodPost, "/internal/agent/sessions/s/events", strings.NewReader(string(body))), map[string]string{"session_id": "s"})
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()

		handler.PostSessionEvent(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, "s", svc.got.SessionID)
		assert.Equal(t, "text", svc.got.EventType)
	})
}
