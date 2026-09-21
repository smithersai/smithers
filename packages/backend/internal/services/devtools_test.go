package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// fakeDevtoolsQuerier is an in-memory stub for DevtoolsQuerier. Tests inject
// deterministic state instead of mocking row scans. Mirrors the
// fakeApprovalsQuerier pattern in approvals_test.go.
type fakeDevtoolsQuerier struct {
	sessions  map[string]db.AgentSession
	snapshots map[string]db.DevtoolsSnapshot // keyed by session_id|kind

	// upsertHook lets tests observe the full params passed into Upsert.
	upsertHook func(db.UpsertDevtoolsSnapshotParams)
}

func newFakeDevtoolsQuerier() *fakeDevtoolsQuerier {
	return &fakeDevtoolsQuerier{
		sessions:  make(map[string]db.AgentSession),
		snapshots: make(map[string]db.DevtoolsSnapshot),
	}
}

func snapKey(sessionID, kind string) string {
	return sessionID + "|" + kind
}

func (f *fakeDevtoolsQuerier) GetAgentSession(_ context.Context, id string) (db.AgentSession, error) {
	s, ok := f.sessions[id]
	if !ok {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	return s, nil
}

func (f *fakeDevtoolsQuerier) UpsertDevtoolsSnapshot(_ context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	if f.upsertHook != nil {
		f.upsertHook(arg)
	}
	// Simulate ON CONFLICT DO UPDATE: second write for the same
	// (session_id, kind) replaces the row and bumps the timestamp.
	row := db.DevtoolsSnapshot{
		SessionID:    arg.SessionID,
		RepositoryID: arg.RepositoryID,
		Kind:         arg.Kind,
		Payload:      arg.Payload,
		Timestamp:    time.Now().UTC(),
	}
	f.snapshots[snapKey(arg.SessionID, arg.Kind)] = row
	return row, nil
}

func (f *fakeDevtoolsQuerier) GetDevtoolsSnapshot(_ context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	r, ok := f.snapshots[snapKey(arg.SessionID, arg.Kind)]
	if !ok {
		return db.DevtoolsSnapshot{}, pgx.ErrNoRows
	}
	return r, nil
}

func sampleDevtoolsSession(t *testing.T) db.AgentSession {
	t.Helper()
	return db.AgentSession{
		ID:           "77777777-2222-3333-4444-555555555555",
		RepositoryID: 42,
		UserID:       7,
		Status:       "active",
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
}

// -----------------------------------------------------------------------------
// WriteSnapshot — happy path + validation matrix.
// -----------------------------------------------------------------------------

func TestDevtoolsService_WriteSnapshot_PersistsRowWithSessionRepoID(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	var captured db.UpsertDevtoolsSnapshotParams
	q.upsertHook = func(arg db.UpsertDevtoolsSnapshotParams) { captured = arg }

	svc := NewDevtoolsService(q)
	resp, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindFileTree,
		Payload:   []byte(`{"root":"src","files":["main.go"]}`),
	})
	require.NoError(t, err)
	assert.Equal(t, DevtoolsKindFileTree, resp.Kind)
	// repository_id is derived from the session, NOT the caller.
	assert.Equal(t, int64(42), resp.RepositoryID)
	assert.Equal(t, int64(42), captured.RepositoryID)
	assert.Equal(t, s.ID, captured.SessionID)
	assert.Equal(t, `{"root":"src","files":["main.go"]}`, string(captured.Payload))
}

func TestDevtoolsService_WriteSnapshot_UnknownSession_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc := NewDevtoolsService(newFakeDevtoolsQuerier())
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: "ghost",
		Kind:      DevtoolsKindFileTree,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusNotFound, apiErr.Status)
}

func TestDevtoolsService_WriteSnapshot_RejectsUnknownKind(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s
	svc := NewDevtoolsService(q)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      "not_a_real_kind",
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)
	assert.Contains(t, apiErr.Message, "kind")
}

func TestDevtoolsService_WriteSnapshot_RejectsOversizedPayload(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s
	svc := NewDevtoolsService(q)

	big := make([]byte, MaxDevtoolsPayloadBytes+1)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindScreenshot,
		Payload:   big,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)
	assert.True(t, strings.Contains(apiErr.Message, "payload"))
}

func TestDevtoolsService_WriteSnapshot_RejectsNonObjectPayload(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s
	svc := NewDevtoolsService(q)

	cases := []struct {
		name    string
		payload string
	}{
		{"array", `[1,2,3]`},
		{"scalar string", `"hello"`},
		{"scalar number", `42`},
		{"not json", `not-json-at-all`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
				SessionID: s.ID,
				Kind:      DevtoolsKindCommandOutput,
				Payload:   []byte(tc.payload),
			})
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, httpStatusBadRequest, apiErr.Status)
		})
	}
}

func TestDevtoolsService_WriteSnapshot_EmptyPayloadDefaultsToObject(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	var captured db.UpsertDevtoolsSnapshotParams
	q.upsertHook = func(arg db.UpsertDevtoolsSnapshotParams) { captured = arg }

	svc := NewDevtoolsService(q)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindToolState,
	})
	require.NoError(t, err)
	assert.Equal(t, `{}`, string(captured.Payload))
}

// -----------------------------------------------------------------------------
// Latest-wins semantic: the core retention contract from the ticket.
// -----------------------------------------------------------------------------

// TestDevtoolsService_WriteSnapshot_LatestWins asserts that a second write
// for the same (session_id, kind) replaces the first: the stored payload
// is the second one and only one row exists for the pair.
func TestDevtoolsService_WriteSnapshot_LatestWins(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	svc := NewDevtoolsService(q)

	first, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindFileTree,
		Payload:   []byte(`{"files":["v1.go"]}`),
	})
	require.NoError(t, err)

	// Small sleep so the second timestamp is strictly greater than the
	// first one even at nanosecond resolution on slow CI.
	time.Sleep(time.Millisecond)

	second, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindFileTree,
		Payload:   []byte(`{"files":["v2.go"]}`),
	})
	require.NoError(t, err)

	// The UPSERT must produce exactly one row for (session, kind) — latest-
	// wins is a schema invariant, not a convention.
	assert.Len(t, q.snapshots, 1, "latest-per-kind: only one row should exist for the pair")

	stored, err := svc.GetSnapshot(context.Background(), s.ID, DevtoolsKindFileTree, 42)
	require.NoError(t, err)
	assert.Equal(t, `{"files":["v2.go"]}`, string(stored.Payload), "stored payload must be the second write's payload")
	assert.NotEqual(t, first.Timestamp, second.Timestamp, "timestamp must advance on overwrite")
}

// TestDevtoolsService_WriteSnapshot_DifferentKindsCoexist asserts that two
// writes for the same session but different kinds produce two distinct
// rows — the retention policy is per-(session, kind), NOT per-session.
func TestDevtoolsService_WriteSnapshot_DifferentKindsCoexist(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	svc := NewDevtoolsService(q)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindFileTree,
		Payload:   []byte(`{"root":"a"}`),
	})
	require.NoError(t, err)
	_, err = svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindScreenshot,
		Payload:   []byte(`{"url":"s3://x"}`),
	})
	require.NoError(t, err)

	assert.Len(t, q.snapshots, 2, "different kinds must produce distinct rows for the same session")
}

// -----------------------------------------------------------------------------
// GetSnapshot — repo scoping.
// -----------------------------------------------------------------------------

func TestDevtoolsService_GetSnapshot_WrongRepo_Returns404(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	svc := NewDevtoolsService(q)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindCommandOutput,
		Payload:   []byte(`{"stdout":"ok"}`),
	})
	require.NoError(t, err)

	_, err = svc.GetSnapshot(context.Background(), s.ID, DevtoolsKindCommandOutput, 99 /* wrong repo */)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusNotFound, apiErr.Status)
}

// -----------------------------------------------------------------------------
// Fan-out shaped check: two readers see the same snapshot after a single
// write, simulating the realtime stream delivering to multiple subscribed
// clients.
// -----------------------------------------------------------------------------

func TestDevtoolsService_FanOut_SharedLatestSnapshot(t *testing.T) {
	t.Parallel()
	q := newFakeDevtoolsQuerier()
	s := sampleDevtoolsSession(t)
	q.sessions[s.ID] = s

	svc := NewDevtoolsService(q)
	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{
		SessionID: s.ID,
		Kind:      DevtoolsKindToolState,
		Payload:   []byte(`{"step":"plan"}`),
	})
	require.NoError(t, err)

	r1, err := svc.GetSnapshot(context.Background(), s.ID, DevtoolsKindToolState, 42)
	require.NoError(t, err)
	r2, err := svc.GetSnapshot(context.Background(), s.ID, DevtoolsKindToolState, 42)
	require.NoError(t, err)
	assert.Equal(t, r1.Payload, r2.Payload)
	assert.Equal(t, r1.Timestamp, r2.Timestamp)
}
