package routes

import (
	"bytes"
	"context"
	"encoding/json"
	stderrors "errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const devtoolsSnapshotPayloadMaxBytes = 1 << 20

// DevtoolsSnapshotRouteQuerier is the db surface required by the repo-scoped
// devtools snapshot HTTP handlers.
type DevtoolsSnapshotRouteQuerier interface {
	UpsertDevtoolsSnapshot(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	GetDevtoolsSnapshot(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	ListDevtoolsSnapshotsBySession(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error)
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
}

// DevtoolsSnapshotsHandler handles repo-scoped devtools snapshot routes.
type DevtoolsSnapshotsHandler struct {
	Queries DevtoolsSnapshotRouteQuerier
	// Enabled gates the devtools snapshot surface. It is resolved once from
	// the canonical config (feature_flags.devtools_snapshot_enabled, which
	// defaults to false) and wired in by the caller — never read from the
	// environment directly, so an unset flag is disabled, not enabled.
	Enabled bool
}

type postDevtoolsSnapshotRequest struct {
	RepositoryID *int64          `json:"repository_id,omitempty"`
	Kind         string          `json:"kind"`
	SessionID    string          `json:"session_id"`
	WorkspaceID  *string         `json:"workspace_id,omitempty"`
	Payload      json.RawMessage `json:"payload"`
}

type devtoolsSnapshotCreatedResponse struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

type devtoolsSnapshotResponse struct {
	ID           string          `json:"id"`
	SessionID    string          `json:"session_id"`
	RepositoryID int64           `json:"repository_id"`
	Kind         string          `json:"kind"`
	WorkspaceID  *string         `json:"workspace_id,omitempty"`
	Payload      json.RawMessage `json:"payload"`
	CreatedAt    time.Time       `json:"created_at"`
}

type devtoolsSnapshotListResponse struct {
	Snapshots []devtoolsSnapshotResponse `json:"snapshots"`
}

// RegisterDevtoolsSnapshotRoutes mounts the repo-scoped devtools snapshot
// routes under /api/repos/{owner}/{repo}. enabled reflects the resolved
// feature_flags.devtools_snapshot_enabled config value (defaults false).
func RegisterDevtoolsSnapshotRoutes(r chi.Router, queries *db.Queries, readRepo, writeRepo []func(http.Handler) http.Handler, enabled bool) {
	if r == nil || queries == nil {
		return
	}

	handler := &DevtoolsSnapshotsHandler{Queries: queries, Enabled: enabled}
	r.With(writeRepo...).Post("/devtools/snapshots", handler.PostSnapshot)
	r.With(readRepo...).Get("/devtools/snapshots", handler.GetSnapshots)
	r.With(readRepo...).Get("/devtools/snapshots/latest", handler.GetSnapshots)
}

// PostSnapshot handles POST /api/repos/{owner}/{repo}/devtools/snapshots.
func (h *DevtoolsSnapshotsHandler) PostSnapshot(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshots are disabled"))
		return
	}

	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	var req postDevtoolsSnapshotRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.RepositoryID != nil && *req.RepositoryID != repo.ID {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository_id does not match repository route"))
		return
	}

	kind, apiErr := normalizeDevtoolsSnapshotKind(req.Kind)
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	sessionID, apiErr := validateRequiredUUID(req.SessionID, "session_id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	// Verify the session belongs to the repository resolved from the route.
	// Without this check a caller with write access to any repo could supply
	// another tenant's session_id and, because UpsertDevtoolsSnapshot rebinds
	// repository_id on conflict, overwrite/rebind that tenant's snapshot row.
	// Return NotFound (not Forbidden) on mismatch so we do not confirm the
	// existence of another tenant's session.
	session, err := h.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		if stderrors.Is(err, pgx.ErrNoRows) {
			pkgerrors.WriteError(w, pkgerrors.NotFound("agent session not found"))
			return
		}
		writeRouteError(w, r, err)
		return
	}
	if session.RepositoryID != repo.ID {
		pkgerrors.WriteError(w, pkgerrors.NotFound("agent session not found"))
		return
	}

	workspaceID, apiErr := validateOptionalUUID(req.WorkspaceID, "workspace_id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	payload, apiErr := normalizeDevtoolsSnapshotPayload(req.Payload, workspaceID)
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	snapshot, err := h.Queries.UpsertDevtoolsSnapshot(r.Context(), db.UpsertDevtoolsSnapshotParams{
		SessionID:    sessionID,
		RepositoryID: repo.ID,
		Kind:         kind,
		Payload:      payload,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, devtoolsSnapshotCreatedResponse{
		ID:        devtoolsSnapshotID(snapshot),
		CreatedAt: snapshot.Timestamp,
	})
}

// GetSnapshots handles GET /api/repos/{owner}/{repo}/devtools/snapshots and
// GET /api/repos/{owner}/{repo}/devtools/snapshots/latest.
func (h *DevtoolsSnapshotsHandler) GetSnapshots(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled {
		pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshots are disabled"))
		return
	}

	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repo := middleware.RepoFromContext(r.Context())
	if repo == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	query := r.URL.Query()
	sessionID, apiErr := validateRequiredUUID(query.Get("session_id"), "session_id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	if rawRepositoryID := strings.TrimSpace(query.Get("repository_id")); rawRepositoryID != "" {
		repositoryID, err := strconv.ParseInt(rawRepositoryID, 10, 64)
		if err != nil || repositoryID <= 0 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("repository_id must be a positive integer"))
			return
		}
		if repositoryID != repo.ID {
			pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshot not found"))
			return
		}
	}

	workspaceID, apiErr := validateOptionalUUID(queryStringPtr(query.Get("workspace_id")), "workspace_id")
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	rawKind := strings.TrimSpace(query.Get("kind"))
	if rawKind != "" {
		kind, kindErr := normalizeDevtoolsSnapshotKind(rawKind)
		if kindErr != nil {
			pkgerrors.WriteError(w, kindErr)
			return
		}

		snapshot, err := h.Queries.GetDevtoolsSnapshot(r.Context(), db.GetDevtoolsSnapshotParams{
			SessionID: sessionID,
			Kind:      kind,
		})
		if err != nil {
			if stderrors.Is(err, pgx.ErrNoRows) {
				pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshot not found"))
				return
			}
			writeRouteError(w, r, err)
			return
		}
		if snapshot.RepositoryID != repo.ID || !snapshotMatchesWorkspace(snapshot, workspaceID) {
			pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshot not found"))
			return
		}

		pkgerrors.WriteJSON(w, http.StatusOK, devtoolsSnapshotListResponse{
			Snapshots: []devtoolsSnapshotResponse{mapDevtoolsSnapshotResponse(snapshot)},
		})
		return
	}

	snapshots, err := h.Queries.ListDevtoolsSnapshotsBySession(r.Context(), db.ListDevtoolsSnapshotsBySessionParams{
		RepositoryID: repo.ID,
		SessionID:    sessionID,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := make([]devtoolsSnapshotResponse, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if snapshotMatchesWorkspace(snapshot, workspaceID) {
			resp = append(resp, mapDevtoolsSnapshotResponse(snapshot))
		}
	}
	if len(resp) == 0 {
		pkgerrors.WriteError(w, pkgerrors.NotFound("devtools snapshot not found"))
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, devtoolsSnapshotListResponse{Snapshots: resp})
}

func normalizeDevtoolsSnapshotKind(raw string) (string, *pkgerrors.APIError) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "kind",
			Code:     "missing_field",
		})
	case "console", "command-output", "command_output":
		return "command_output", nil
	case "network", "tool-state", "tool_state":
		return "tool_state", nil
	case "file-tree", "file_tree":
		return "file_tree", nil
	case "screenshot":
		return "screenshot", nil
	default:
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "kind",
			Code:     "invalid",
		})
	}
}

func validateRequiredUUID(raw, field string) (string, *pkgerrors.APIError) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "missing_field",
		})
	}
	if _, err := uuid.Parse(trimmed); err != nil {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "invalid",
		})
	}
	return trimmed, nil
}

func validateOptionalUUID(raw *string, field string) (*string, *pkgerrors.APIError) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	if _, err := uuid.Parse(trimmed); err != nil {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    field,
			Code:     "invalid",
		})
	}
	return &trimmed, nil
}

func normalizeDevtoolsSnapshotPayload(raw json.RawMessage, workspaceID *string) (json.RawMessage, *pkgerrors.APIError) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "payload",
			Code:     "missing_field",
		})
	}
	if len(trimmed) > devtoolsSnapshotPayloadMaxBytes {
		return nil, pkgerrors.RequestEntityTooLarge("payload too large")
	}

	var payload map[string]any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "DevtoolsSnapshot",
			Field:    "payload",
			Code:     "invalid",
		})
	}

	// The schema landed without a dedicated workspace_id column; preserve the
	// request field in the JSON payload until ticket 0157 gives it a home.
	if workspaceID != nil {
		if _, exists := payload["workspace_id"]; !exists {
			payload["workspace_id"] = *workspaceID
		}
	}

	encoded := mustMarshalDevtoolsSnapshotPayload(payload)
	if len(encoded) > devtoolsSnapshotPayloadMaxBytes {
		return nil, pkgerrors.RequestEntityTooLarge("payload too large")
	}
	return json.RawMessage(encoded), nil
}

func mustMarshalDevtoolsSnapshotPayload(payload map[string]any) []byte {
	encoded, err := json.Marshal(payload)
	if err != nil {
		panic(fmt.Sprintf("devtools snapshot payload should be JSON-marshalable after JSON decode: %v", err))
	}
	return encoded
}

func mapDevtoolsSnapshotResponse(snapshot db.DevtoolsSnapshot) devtoolsSnapshotResponse {
	return devtoolsSnapshotResponse{
		ID:           devtoolsSnapshotID(snapshot),
		SessionID:    snapshot.SessionID,
		RepositoryID: snapshot.RepositoryID,
		Kind:         snapshot.Kind,
		WorkspaceID:  snapshotWorkspaceID(snapshot.Payload),
		Payload:      snapshot.Payload,
		CreatedAt:    snapshot.Timestamp,
	}
}

func devtoolsSnapshotID(snapshot db.DevtoolsSnapshot) string {
	return fmt.Sprintf("%s:%s", snapshot.SessionID, snapshot.Kind)
}

func snapshotWorkspaceID(payload json.RawMessage) *string {
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil
	}

	raw, ok := data["workspace_id"].(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func snapshotMatchesWorkspace(snapshot db.DevtoolsSnapshot, workspaceID *string) bool {
	if workspaceID == nil {
		return true
	}

	stored := snapshotWorkspaceID(snapshot.Payload)
	if stored == nil {
		return false
	}
	return *stored == *workspaceID
}

func queryStringPtr(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
