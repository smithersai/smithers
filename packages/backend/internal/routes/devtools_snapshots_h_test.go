package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDevtoolsSnapshots_H_RegisterAndPostBranches(t *testing.T) {
	router := chi.NewRouter()
	require.NotPanics(t, func() {
		RegisterDevtoolsSnapshotRoutes(router, &db.Queries{}, nil, nil, true)
	})

	sessionID := "11111111-1111-1111-1111-111111111111"
	workspaceID := "22222222-2222-2222-2222-222222222222"

	cases := []struct {
		name    string
		body    string
		queries *mockDevtoolsSnapshotRouteQuerier
		want    int
	}{
		{
			name: "invalid json",
			body: `{`,
			want: http.StatusBadRequest,
		},
		{
			name: "invalid kind",
			body: `{"kind":"unknown","session_id":"` + sessionID + `","payload":{"ok":true}}`,
			want: http.StatusUnprocessableEntity,
		},
		{
			name: "missing session id",
			body: `{"kind":"console","payload":{"ok":true}}`,
			want: http.StatusUnprocessableEntity,
		},
		{
			name: "invalid workspace id",
			body: `{"kind":"console","session_id":"` + sessionID + `","workspace_id":"bad","payload":{"ok":true}}`,
			queries: &mockDevtoolsSnapshotRouteQuerier{
				getSessionFn: func(context.Context, string) (db.AgentSession, error) {
					return db.AgentSession{ID: sessionID, RepositoryID: 101}, nil
				},
			},
			want: http.StatusUnprocessableEntity,
		},
		{
			name: "payload validation error",
			body: `{"kind":"console","session_id":"` + sessionID + `","payload":null}`,
			queries: &mockDevtoolsSnapshotRouteQuerier{
				getSessionFn: func(context.Context, string) (db.AgentSession, error) {
					return db.AgentSession{ID: sessionID, RepositoryID: 101}, nil
				},
			},
			want: http.StatusUnprocessableEntity,
		},
		{
			name: "upsert error",
			body: `{"kind":"console","session_id":"` + sessionID + `","workspace_id":"` + workspaceID + `","payload":{"ok":true}}`,
			queries: &mockDevtoolsSnapshotRouteQuerier{
				getSessionFn: func(context.Context, string) (db.AgentSession, error) {
					return db.AgentSession{ID: sessionID, RepositoryID: 101}, nil
				},
				upsertFn: func(context.Context, db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
					return db.DevtoolsSnapshot{}, pkgerrors.Internal("insert failed")
				},
			},
			want: http.StatusInternalServerError,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			queries := tc.queries
			if queries == nil {
				queries = &mockDevtoolsSnapshotRouteQuerier{}
			}
			handler := &DevtoolsSnapshotsHandler{Queries: queries, Enabled: true}
			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(tc.body))
			req = withRepoContext(req, "alice", "demo")
			req = withAuth(req, 7, "alice")
			rec := httptest.NewRecorder()
			handler.PostSnapshot(rec, req)
			require.Equal(t, tc.want, rec.Code)
		})
	}
}

func TestDevtoolsSnapshots_H_GetAndHelperBranches(t *testing.T) {
	sessionID := "11111111-1111-1111-1111-111111111111"
	workspaceID := "22222222-2222-2222-2222-222222222222"

	t.Run("kind lookup service error", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			getFn: func(context.Context, db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
				return db.DevtoolsSnapshot{}, errors.New("database offline")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID+"&kind=console", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		handler.GetSnapshots(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("list service error and no matching snapshots", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			listFn: func(context.Context, db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error) {
				return nil, errors.New("list failed")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID, nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		handler.GetSnapshots(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler = &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			listFn: func(context.Context, db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error) {
				return []db.DevtoolsSnapshot{{SessionID: sessionID, RepositoryID: 101, Kind: "console", Payload: json.RawMessage(`{"workspace_id":"33333333-3333-3333-3333-333333333333"}`), Timestamp: time.Unix(1, 0)}}, nil
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID+"&workspace_id="+workspaceID, nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		handler.GetSnapshots(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("optional uuid empty and must marshal panic", func(t *testing.T) {
		empty := "  "
		got, apiErr := validateOptionalUUID(&empty, "workspace_id")
		require.Nil(t, apiErr)
		require.Nil(t, got)

		workspaceID := "22222222-2222-2222-2222-222222222222"
		raw := json.RawMessage(`{"x":"` + strings.Repeat("x", devtoolsSnapshotPayloadMaxBytes-len(`{"x":""}`)) + `"}`)
		_, apiErr = normalizeDevtoolsSnapshotPayload(raw, &workspaceID)
		require.NotNil(t, apiErr)
		require.Equal(t, http.StatusRequestEntityTooLarge, apiErr.Status)

		require.Panics(t, func() {
			mustMarshalDevtoolsSnapshotPayload(map[string]any{"bad": make(chan int)})
		})
	})
}
