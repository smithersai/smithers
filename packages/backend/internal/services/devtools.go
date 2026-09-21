// Package services — devtools snapshot service (ticket 0107).
//
// Provides the smithers-side API for the generic "what is the agent looking at
// right now" feed:
//
//   - WriteSnapshot(ctx, input): called by the guest-agent forwarder when the
//     agent runtime emits MethodWriteDevtoolsSnapshot. Resolves the session,
//     derives repository_id from it, and UPSERTs the row keyed by
//     (session_id, kind).
//
// Retention policy: LATEST-PER-KIND. This is not a history log. Every write
// for the same (session_id, kind) clobbers the previous row via the
// UpsertDevtoolsSnapshot query's ON CONFLICT DO UPDATE clause. Callers that
// want a timeline should emit their own append-only log elsewhere.
//
// Large payloads: app-layer capped at 256 KiB (MaxDevtoolsPayloadBytes).
// Screenshots larger than that must be uploaded to blob storage by the
// client and the returned reference embedded in the JSON payload. Blob
// storage integration is out of scope for ticket 0107.
package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MaxDevtoolsPayloadBytes caps the serialized JSON payload a single snapshot
// can carry. 256 KiB matches the approvals service cap (ticket 0110) and
// the defensive cap in the guest-agent handler. Screenshots exceeding this
// should be uploaded to blob storage and referenced by URL.
const MaxDevtoolsPayloadBytes = 256 * 1024

// Devtools snapshot kinds. Mirrors the CHECK constraint in
// db/migrations/000037_add_devtools_snapshots.sql. Callers MUST use these
// constants instead of string literals so a schema-level kind addition is
// a single-line PR.
const (
	DevtoolsKindFileTree      = "file_tree"
	DevtoolsKindScreenshot    = "screenshot"
	DevtoolsKindCommandOutput = "command_output"
	DevtoolsKindToolState     = "tool_state"
)

// validDevtoolsKinds is the authoritative enum used by the service-layer
// validator. Adding a kind here without also updating the CHECK constraint
// in the migration will fail loudly on the first write (fail-closed).
var validDevtoolsKinds = map[string]struct{}{
	DevtoolsKindFileTree:      {},
	DevtoolsKindScreenshot:    {},
	DevtoolsKindCommandOutput: {},
	DevtoolsKindToolState:     {},
}

// DevtoolsQuerier is the minimal DB surface the DevtoolsService needs.
// Lives alongside ApprovalsQuerier so tests can stub narrowly without
// pulling in the whole Queries interface.
type DevtoolsQuerier interface {
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
	UpsertDevtoolsSnapshot(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	GetDevtoolsSnapshot(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
}

// WriteSnapshotInput is the service-layer input for persisting a snapshot.
// SessionID is the agent session the snapshot describes; RepositoryID is
// derived server-side from the session, not trusted from the caller.
type WriteSnapshotInput struct {
	SessionID string
	Kind      string
	Payload   []byte // JSON-encoded object; may be empty (treated as `{}`)
}

// DevtoolsSnapshotResponse is the API DTO returned from service methods.
// It is JSON-serialisable and mirrors the DB row shape 1:1.
type DevtoolsSnapshotResponse struct {
	SessionID    string          `json:"session_id"`
	RepositoryID int64           `json:"repository_id"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
	Timestamp    string          `json:"timestamp"` // RFC3339
}

// DevtoolsService owns the devtools snapshot lifecycle. Construct via
// NewDevtoolsService.
type DevtoolsService struct {
	q DevtoolsQuerier
}

// NewDevtoolsService constructs a service backed by q.
func NewDevtoolsService(q DevtoolsQuerier) *DevtoolsService {
	return &DevtoolsService{q: q}
}

// WriteSnapshot persists (or overwrites) the snapshot for (session_id, kind).
//
// Contract:
//   - Unknown session -> 404 NotFound.
//   - Kind not in validDevtoolsKinds -> 400 BadRequest. Keeping the enum
//     small for v1 is deliberate; new kinds land alongside a migration that
//     relaxes the CHECK constraint.
//   - Payload > MaxDevtoolsPayloadBytes -> 400 BadRequest. Large screenshots
//     must go to blob storage.
//   - Payload not a valid JSON object -> 400 BadRequest. The JSONB CHECK in
//     the DB requires jsonb_typeof = 'object'; we enforce it up-front so the
//     error surface is consistent.
//
// On success, returns the persisted row. The UPSERT guarantees the returned
// timestamp reflects this write, not the prior one.
func (s *DevtoolsService) WriteSnapshot(ctx context.Context, input WriteSnapshotInput) (DevtoolsSnapshotResponse, error) {
	if input.SessionID == "" {
		return DevtoolsSnapshotResponse{}, pkgerrors.BadRequest("session_id is required")
	}
	if input.Kind == "" {
		return DevtoolsSnapshotResponse{}, pkgerrors.BadRequest("kind is required")
	}
	if _, ok := validDevtoolsKinds[input.Kind]; !ok {
		return DevtoolsSnapshotResponse{}, pkgerrors.BadRequest("kind is not in the allowed enum")
	}
	if len(input.Payload) > MaxDevtoolsPayloadBytes {
		return DevtoolsSnapshotResponse{}, pkgerrors.BadRequest("payload exceeds size limit")
	}

	// Normalize payload: empty -> `{}`, non-empty must parse as a JSON object.
	payload := input.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	} else {
		if !isJSONObject(payload) {
			return DevtoolsSnapshotResponse{}, pkgerrors.BadRequest("payload must be a JSON object")
		}
	}

	// Session -> repository_id. The guest is outside Smithers's trust boundary,
	// so we refuse to accept a caller-supplied repository_id.
	session, err := s.q.GetAgentSession(ctx, input.SessionID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return DevtoolsSnapshotResponse{}, pkgerrors.NotFound("agent session not found")
		}
		return DevtoolsSnapshotResponse{}, pkgerrors.Internal("load session: " + err.Error())
	}

	row, err := s.q.UpsertDevtoolsSnapshot(ctx, db.UpsertDevtoolsSnapshotParams{
		SessionID:    session.ID,
		RepositoryID: session.RepositoryID,
		Kind:         input.Kind,
		Payload:      payload,
	})
	if err != nil {
		return DevtoolsSnapshotResponse{}, pkgerrors.Internal("upsert snapshot: " + err.Error())
	}
	return toDevtoolsSnapshotResponse(row), nil
}

// GetSnapshot fetches a single snapshot for (session_id, kind) scoped to a
// repository. Primarily used for admin tooling and tests; clients read via
// the realtime stream.
func (s *DevtoolsService) GetSnapshot(ctx context.Context, sessionID, kind string, repoID int64) (DevtoolsSnapshotResponse, error) {
	row, err := s.q.GetDevtoolsSnapshot(ctx, db.GetDevtoolsSnapshotParams{
		SessionID: sessionID,
		Kind:      kind,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return DevtoolsSnapshotResponse{}, pkgerrors.NotFound("snapshot not found")
		}
		return DevtoolsSnapshotResponse{}, pkgerrors.Internal(err.Error())
	}
	if row.RepositoryID != repoID {
		// Treat cross-repo access as a 404 so route scope is a
		// non-discoverable boundary (same policy as ApprovalsService).
		return DevtoolsSnapshotResponse{}, pkgerrors.NotFound("snapshot not found")
	}
	return toDevtoolsSnapshotResponse(row), nil
}

// isJSONObject returns true iff payload parses as a JSON object (not an
// array, literal, or scalar). The DB's jsonb_typeof = 'object' CHECK would
// catch the violation eventually, but we want a 400 instead of a 500.
func isJSONObject(payload []byte) bool {
	var probe any
	if err := json.Unmarshal(payload, &probe); err != nil {
		return false
	}
	_, ok := probe.(map[string]any)
	return ok
}

// toDevtoolsSnapshotResponse converts a db.DevtoolsSnapshot row into its API
// DTO. Timestamp is RFC3339 to keep the wire format stable across clients
// that can't agree on a Date shape.
func toDevtoolsSnapshotResponse(row db.DevtoolsSnapshot) DevtoolsSnapshotResponse {
	return DevtoolsSnapshotResponse{
		SessionID:    row.SessionID,
		RepositoryID: row.RepositoryID,
		Kind:         row.Kind,
		Payload:      row.Payload,
		Timestamp:    row.Timestamp.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
	}
}
