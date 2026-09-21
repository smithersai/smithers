package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockDevtoolsSnapshotRouteQuerier struct {
	upsertFn     func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	getFn        func(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	listFn       func(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error)
	getSessionFn func(ctx context.Context, id string) (db.AgentSession, error)
}

func (m *mockDevtoolsSnapshotRouteQuerier) UpsertDevtoolsSnapshot(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	if m.upsertFn != nil {
		return m.upsertFn(ctx, arg)
	}
	return db.DevtoolsSnapshot{}, nil
}

func (m *mockDevtoolsSnapshotRouteQuerier) GetDevtoolsSnapshot(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	if m.getFn != nil {
		return m.getFn(ctx, arg)
	}
	return db.DevtoolsSnapshot{}, nil
}

func (m *mockDevtoolsSnapshotRouteQuerier) ListDevtoolsSnapshotsBySession(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error) {
	if m.listFn != nil {
		return m.listFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockDevtoolsSnapshotRouteQuerier) GetAgentSession(ctx context.Context, id string) (db.AgentSession, error) {
	if m.getSessionFn != nil {
		return m.getSessionFn(ctx, id)
	}
	return db.AgentSession{}, nil
}

func TestDevtoolsSnapshotsHandler_GetSnapshots_LatestKindReturnsSingleSnapshotList(t *testing.T) {
	t.Parallel()

	sessionID := "11111111-1111-1111-1111-111111111111"
	now := time.Unix(1_700_000_000, 0).UTC()
	handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
		getFn: func(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
			assert.Equal(t, sessionID, arg.SessionID)
			assert.Equal(t, "command_output", arg.Kind)
			return db.DevtoolsSnapshot{
				SessionID:    sessionID,
				RepositoryID: 101,
				Kind:         "command_output",
				Payload:      json.RawMessage(`{"workspace_id":"22222222-2222-2222-2222-222222222222","content":"tail -f app.log"}`),
				Timestamp:    now,
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots/latest?session_id="+sessionID+"&kind=console", nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.GetSnapshots(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var body devtoolsSnapshotListResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Snapshots, 1)
	assert.Equal(t, "command_output", body.Snapshots[0].Kind)
	assert.Equal(t, sessionID, body.Snapshots[0].SessionID)
	assert.Equal(t, int64(101), body.Snapshots[0].RepositoryID)
	assert.Equal(t, now, body.Snapshots[0].CreatedAt)
}

func TestDevtoolsSnapshotsHandler_GetSnapshots_LatestReturnsAllKinds(t *testing.T) {
	t.Parallel()

	sessionID := "11111111-1111-1111-1111-111111111111"
	now := time.Unix(1_700_000_100, 0).UTC()
	handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
		listFn: func(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error) {
			assert.Equal(t, int64(101), arg.RepositoryID)
			assert.Equal(t, sessionID, arg.SessionID)
			return []db.DevtoolsSnapshot{
				{
					SessionID:    sessionID,
					RepositoryID: 101,
					Kind:         "command_output",
					Payload:      json.RawMessage(`{"content":"console output"}`),
					Timestamp:    now,
				},
				{
					SessionID:    sessionID,
					RepositoryID: 101,
					Kind:         "tool_state",
					Payload:      json.RawMessage(`{"requests":3}`),
					Timestamp:    now.Add(time.Second),
				},
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots/latest?session_id="+sessionID, nil)
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.GetSnapshots(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var body devtoolsSnapshotListResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Snapshots, 2)
	assert.Equal(t, "command_output", body.Snapshots[0].Kind)
	assert.Equal(t, "tool_state", body.Snapshots[1].Kind)
}

func TestDevtoolsSnapshotsHandler_PostSnapshot_RejectsCrossTenantSession(t *testing.T) {
	t.Parallel()

	sessionID := "11111111-1111-1111-1111-111111111111"
	upsertCalled := false
	handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
		getSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
			// Session belongs to a DIFFERENT repository than the route repo (101).
			return db.AgentSession{ID: id, RepositoryID: 999}, nil
		},
		upsertFn: func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
			upsertCalled = true
			return db.DevtoolsSnapshot{}, nil
		},
	}}

	body := `{"kind":"console","session_id":"` + sessionID + `","payload":{"content":"x"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(body))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.PostSnapshot(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.False(t, upsertCalled, "upsert must not run for a cross-tenant session")
}

func TestDevtoolsSnapshotsHandler_PostSnapshot_RejectsUnknownSession(t *testing.T) {
	t.Parallel()

	sessionID := "11111111-1111-1111-1111-111111111111"
	upsertCalled := false
	handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
		getSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
			return db.AgentSession{}, pgx.ErrNoRows
		},
		upsertFn: func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
			upsertCalled = true
			return db.DevtoolsSnapshot{}, nil
		},
	}}

	body := `{"kind":"console","session_id":"` + sessionID + `","payload":{"content":"x"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(body))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.PostSnapshot(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.False(t, upsertCalled, "upsert must not run for an unknown session")
}

func TestDevtoolsSnapshotsHandler_PostSnapshot_AcceptsMatchingRepoSession(t *testing.T) {
	t.Parallel()

	sessionID := "11111111-1111-1111-1111-111111111111"
	now := time.Unix(1_700_000_200, 0).UTC()
	var upsertRepoID int64
	handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
		getSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
			// Session belongs to the route repo (101).
			return db.AgentSession{ID: id, RepositoryID: 101}, nil
		},
		upsertFn: func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
			upsertRepoID = arg.RepositoryID
			return db.DevtoolsSnapshot{
				SessionID:    arg.SessionID,
				RepositoryID: arg.RepositoryID,
				Kind:         arg.Kind,
				Payload:      arg.Payload,
				Timestamp:    now,
			}, nil
		},
	}}

	body := `{"kind":"console","session_id":"` + sessionID + `","payload":{"content":"x"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(body))
	req = withRepoContext(req, "alice", "demo")
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.PostSnapshot(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, int64(101), upsertRepoID, "snapshot must be keyed to the route repo")
}
