package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// AgentSessionStreamService is the minimal interface required by AgentSessionStreamHandler
// to verify the session exists and belongs to the repository.
type AgentSessionStreamService interface {
	GetAgentMessageStreamHead(context.Context, string) (int64, error)
	// GetSessionForRepo returns the agent session if it exists and belongs to the given repository.
	// Returns an error if the session is not found or does not belong to the repo.
	GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error
	// ListMessagesAfterID returns persisted messages newer than afterID for Last-Event-ID replay.
	ListMessagesAfterID(ctx context.Context, sessionID string, afterID int64, limit int) ([]services.AgentMessageResponse, error)
}

// AgentSessionStreamHandler handles the SSE endpoint for streaming agent session events.
type AgentSessionStreamHandler struct {
	Service AgentSessionStreamService
	// Broker multiplexes all agent-session LISTEN/NOTIFY streams over one shared
	// database connection and enforces the per-user concurrent stream cap.
	// If nil, the SSE stream endpoint returns a 500.
	Broker *sse.Broker
	// Metrics is used to record observability data (e.g. active connections).
	Metrics *SmithersMetrics
}

var (
	serveAgentSessionBrokerSSE       = sse.ServeBrokerSSE
	marshalAgentSessionReplayPayload = json.Marshal
)

// AgentSessionStream handles GET /api/repos/{owner}/{repo}/agent/sessions/{id}/stream.
// SSE endpoint for streaming agent session events (messages, status changes).
//
// This endpoint is exempt from the HTTP timeout middleware because it is a
// long-lived streaming connection. Keep-alive comments are sent every 15 seconds.
//
// The endpoint supports Last-Event-ID header for reconnection. Events are formatted as:
//
//	id: 42
//	event: agent.session
//	data: {"session_id":"abc-123","action":"message","message":{"id":42,...}}
//
// Session status transitions use the same event type without an id line:
//
//	event: agent.session
//	data: {"session_id":"abc-123","action":"status","status":"completed"}
//
// The NOTIFY channel is: agent_session_{session_id_no_dashes}
// (UUID dashes are stripped to form a valid PostgreSQL channel name).
func (h *AgentSessionStreamHandler) AgentSessionStream(w http.ResponseWriter, r *http.Request) {
	// Require authentication.
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	// Parse session ID from URL.
	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	// Get repository from context (set by LoadRepoContext middleware).
	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	// The session id becomes a LISTEN channel name, so accept only UUIDs.
	if _, parseErr := uuid.Parse(sessionID); parseErr != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid session id"))
		return
	}

	// Verify the session exists and belongs to this repository. Without a
	// service the ownership check cannot run, so fail closed.
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}
	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repo.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// Build the LISTEN channel name: agent_session_{uuid_without_dashes}
	// Dashes are stripped from the UUID to form a valid PostgreSQL identifier.
	safeID := strings.ReplaceAll(sessionID, "-", "")
	channel := "agent_session_" + safeID

	stream := h.durableAgentMessages(sessionID)
	cfg := sse.BrokerStreamConfig{
		Durable:       stream,
		Broker:        h.Broker,
		Channel:       channel,
		UserID:        user.ID,
		EventType:     "agent.session",
		FormatEventID: extractAgentEventID,
		OnConnect: func(w http.ResponseWriter, req *http.Request, flusher http.Flusher) {
			middleware.LoggerWithAgentSession(r.Context(), sessionID).Info("agent session SSE stream started",
				"channel", channel,
			)
			stream.OnConnect(w, req, flusher)
		},
	}

	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repo.ID, SessionID: sessionID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveAgentSessionBrokerSSE(w, r, cfg)
}

// Ensure AgentService satisfies AgentSessionStreamService at compile time.
var _ AgentSessionStreamService = (*services.AgentService)(nil)

// extractAgentEventID extracts an "id" or "sequence" field from a JSON agent event payload.
// Returns the stringified value, or "" if extraction fails.
func extractAgentEventID(data string) string {
	var partial struct {
		ID       int64 `json:"id"`
		Sequence int64 `json:"sequence"`
		Message  struct {
			ID       int64 `json:"id"`
			Sequence int64 `json:"sequence"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(data), &partial); err != nil {
		return ""
	}
	if partial.ID > 0 {
		return strconv.FormatInt(partial.ID, 10)
	}
	if partial.Sequence > 0 {
		return strconv.FormatInt(partial.Sequence, 10)
	}
	if partial.Message.ID > 0 {
		return strconv.FormatInt(partial.Message.ID, 10)
	}
	if partial.Message.Sequence > 0 {
		return strconv.FormatInt(partial.Message.Sequence, 10)
	}
	return ""
}
