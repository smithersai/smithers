package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type devtoolsCovErrQuerier struct{}

func (devtoolsCovErrQuerier) GetAgentSession(context.Context, string) (db.AgentSession, error) {
	return db.AgentSession{ID: "sess", RepositoryID: 1}, nil
}

func (devtoolsCovErrQuerier) UpsertDevtoolsSnapshot(context.Context, db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	return db.DevtoolsSnapshot{}, errors.New("upsert failed")
}

func (devtoolsCovErrQuerier) GetDevtoolsSnapshot(context.Context, db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	return db.DevtoolsSnapshot{}, errors.New("get failed")
}

func TestDevtools_Cov_GetSnapshotSuccessCrossRepoAndErrors(t *testing.T) {
	q := newFakeDevtoolsQuerier()
	q.snapshots[snapKey("sess", DevtoolsKindToolState)] = db.DevtoolsSnapshot{
		SessionID: "sess", RepositoryID: 10, Kind: DevtoolsKindToolState, Payload: []byte(`{"ok":true}`), Timestamp: time.Date(2026, 7, 7, 1, 2, 3, 4, time.UTC),
	}
	svc := NewDevtoolsService(q)
	resp, err := svc.GetSnapshot(context.Background(), "sess", DevtoolsKindToolState, 10)
	if err != nil {
		t.Fatalf("GetSnapshot returned error: %v", err)
	}
	if resp.RepositoryID != 10 || resp.Timestamp == "" || string(resp.Payload) != `{"ok":true}` {
		t.Fatalf("resp = %+v", resp)
	}

	_, err = svc.GetSnapshot(context.Background(), "sess", DevtoolsKindToolState, 99)
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusNotFound {
		t.Fatalf("cross repo err = %#v", err)
	}

	_, err = NewDevtoolsService(devtoolsCovErrQuerier{}).GetSnapshot(context.Background(), "sess", "kind", 1)
	apiErr, ok = err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("get err = %#v", err)
	}
}

func TestDevtools_Cov_WriteSnapshotSessionAndUpsertErrors(t *testing.T) {
	q := newFakeDevtoolsQuerier()
	q.sessions["sess"] = db.AgentSession{ID: "sess", RepositoryID: 1}
	q.upsertHook = func(db.UpsertDevtoolsSnapshotParams) {
		panic("hook should not run in invalid json path")
	}
	_, err := NewDevtoolsService(q).WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "sess", Kind: DevtoolsKindFileTree, Payload: []byte(`[]`)})
	if err == nil || !strings.Contains(err.Error(), "object") {
		t.Fatalf("invalid payload err = %v", err)
	}

	_, err = NewDevtoolsService(devtoolsCovErrQuerier{}).WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "sess", Kind: DevtoolsKindFileTree})
	apiErr, ok := err.(*pkgerrors.APIError)
	if !ok || apiErr.Status != http.StatusInternalServerError {
		t.Fatalf("upsert err = %#v", err)
	}

	q = newFakeDevtoolsQuerier()
	q.sessions["sess"] = db.AgentSession{ID: "sess", RepositoryID: 1}
	delete(q.sessions, "sess")
	_, err = NewDevtoolsService(q).WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "sess", Kind: DevtoolsKindFileTree})
	if !errors.Is(err, pgx.ErrNoRows) {
		var apiErr *pkgerrors.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
			t.Fatalf("session err = %#v", err)
		}
	}
}
