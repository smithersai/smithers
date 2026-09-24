package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// AgentTokenQuerier defines the DB operations needed to validate agent tokens.
type AgentTokenQuerier interface {
	GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error)
	GetAgentSessionWorkflowRunID(ctx context.Context, id string) (pgtype.Int8, error)
	// GetWorkflowTaskByRunID is used to verify the task for this run is still
	// active (running/pending), ensuring a token cannot be replayed after the
	// step it was issued for has been terminated.
	GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
}

// AgentInternalRouteService defines the service interface for internal agent callbacks.
type AgentInternalRouteService interface {
	IngestRunnerEvent(ctx context.Context, input services.IngestRunnerEventInput) error
}

// AgentInternalHandler handles internal agent callback endpoints.
// These are called by agent runners (via agent tokens) to post events back.
type AgentInternalHandler struct {
	Service AgentInternalRouteService
	// TokenQuerier validates agent tokens on internal callback requests.
	// If nil, all requests are rejected with 401 (fail closed for security).
	TokenQuerier  AgentTokenQuerier
	validateToken func(ctx context.Context, r *http.Request, sessionID string) error
}

type postSessionEventRequest struct {
	EventType string          `json:"event_type"`
	Content   json.RawMessage `json:"content"`
}

// validateAgentToken extracts and validates the Bearer token from the Authorization header.
// Verifies the token exists, hasn't expired, and is scoped to the given sessionID.
func (h *AgentInternalHandler) validateAgentToken(ctx context.Context, r *http.Request, sessionID string) error {
	if h.TokenQuerier == nil {
		// Token validation not configured; fail closed for security.
		return pkgerrors.Unauthorized("agent token validation not configured")
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return pkgerrors.Unauthorized("missing Authorization header")
	}

	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		return pkgerrors.Unauthorized("Authorization header must use Bearer scheme")
	}

	plaintext := strings.TrimPrefix(authHeader, bearerPrefix)
	if plaintext == "" {
		return pkgerrors.Unauthorized("empty agent token")
	}

	// SHA-256 hash the plaintext token for DB lookup
	sum := sha256.Sum256([]byte(plaintext))
	tokenHash := hex.EncodeToString(sum[:])

	// Look up the workflow run by token hash
	run, err := h.TokenQuerier.GetWorkflowRunByAgentToken(ctx, pgtype.Text{String: tokenHash, Valid: true})
	if err != nil {
		return agentTokenLookupError(ctx, "workflow run", sessionID, err, "invalid or expired agent token")
	}

	// Verify token hasn't expired
	if run.AgentTokenExpiresAt.Valid && run.AgentTokenExpiresAt.Time.Before(time.Now()) {
		return pkgerrors.Unauthorized("agent token has expired")
	}

	// Verify the session's workflow_run_id matches the token's workflow_run_id
	sessionRunID, err := h.TokenQuerier.GetAgentSessionWorkflowRunID(ctx, sessionID)
	if err != nil {
		return agentTokenLookupError(ctx, "agent session", sessionID, err, "session not found")
	}
	if !sessionRunID.Valid || sessionRunID.Int64 != run.ID {
		return pkgerrors.Unauthorized("agent token not authorized for this session")
	}

	// Verify the task for this run is still active (step-level scope constraint).
	// This ensures a token cannot be replayed after the step it was issued for
	// has been terminated (completed, failed, or cancelled).
	task, err := h.TokenQuerier.GetWorkflowTaskByRunID(ctx, run.ID)
	if err != nil {
		return agentTokenLookupError(ctx, "workflow task", sessionID, err, "agent task not found for run")
	}
	switch task.Status {
	case "pending", "running":
		// task is active — allow the callback
	default:
		return pkgerrors.Unauthorized("agent token is no longer valid: task has terminated")
	}

	return nil
}

// agentTokenLookupRetryAfterSeconds paces the runner after a database fault
// during token validation.
const agentTokenLookupRetryAfterSeconds = 5

// agentTokenLookupError maps a missing row to 401 and any other lookup failure
// to a retryable 503. The runner treats 401 as a revoked credential and stops
// posting events, so a database fault must never read as one.
func agentTokenLookupError(ctx context.Context, lookup, sessionID string, err error, notFound string) error {
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Unauthorized(notFound)
	}
	middleware.LoggerFromContext(ctx).Error("agent token validation lookup failed",
		"lookup", lookup, "session_id", sessionID, "error", err)
	apiErr := pkgerrors.New(pkgerrors.CodeServiceUnavailable, "agent token validation temporarily unavailable")
	apiErr.RetryAfter = agentTokenLookupRetryAfterSeconds
	return apiErr
}

// PostSessionEvent handles POST /internal/agent/sessions/{session_id}/events.
// Runner calls this to post text, tool_call, tool_result, and done events.
// Requires a valid agent token in the Authorization: Bearer header.
func (h *AgentInternalHandler) PostSessionEvent(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	sessionID := chi.URLParam(r, "session_id")
	if sessionID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("session_id is required"))
		return
	}

	// Validate agent token before accepting the event.
	validateToken := h.validateAgentToken
	if h.validateToken != nil {
		validateToken = h.validateToken
	}
	if err := validateToken(r.Context(), r, sessionID); err != nil {
		if apiErr, ok := err.(*pkgerrors.APIError); ok {
			pkgerrors.WriteError(w, apiErr)
		} else {
			pkgerrors.WriteError(w, pkgerrors.Unauthorized("unauthorized"))
		}
		return
	}

	var req postSessionEventRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.EventType == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("event_type is required"))
		return
	}

	if err := h.Service.IngestRunnerEvent(r.Context(), services.IngestRunnerEventInput{
		SessionID: sessionID,
		EventType: req.EventType,
		Content:   req.Content,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}

	middleware.LoggerWithAgentSession(r.Context(), sessionID).Info("agent runner event ingested",
		"event_type", req.EventType,
	)

	w.WriteHeader(http.StatusAccepted)
}
