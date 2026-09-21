package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type devtoolsZQuerier struct {
	sessionErr  error
	upsertErr   error
	snapshotErr error
}

func (q devtoolsZQuerier) GetAgentSession(context.Context, string) (db.AgentSession, error) {
	if q.sessionErr != nil {
		return db.AgentSession{}, q.sessionErr
	}
	return db.AgentSession{ID: "session-z", RepositoryID: 11}, nil
}

func (q devtoolsZQuerier) UpsertDevtoolsSnapshot(context.Context, db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	if q.upsertErr != nil {
		return db.DevtoolsSnapshot{}, q.upsertErr
	}
	return db.DevtoolsSnapshot{SessionID: "session-z", RepositoryID: 11, Kind: DevtoolsKindFileTree, Payload: []byte(`{}`), Timestamp: time.Now()}, nil
}

func (q devtoolsZQuerier) GetDevtoolsSnapshot(context.Context, db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
	if q.snapshotErr != nil {
		return db.DevtoolsSnapshot{}, q.snapshotErr
	}
	return db.DevtoolsSnapshot{SessionID: "session-z", RepositoryID: 22, Kind: DevtoolsKindFileTree, Payload: []byte(`{}`), Timestamp: time.Now()}, nil
}

func TestDevtools_Z_WriteAndGetErrorBranches(t *testing.T) {
	svc := NewDevtoolsService(devtoolsZQuerier{})

	_, err := svc.WriteSnapshot(context.Background(), WriteSnapshotInput{Kind: DevtoolsKindFileTree})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = svc.WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "session-z"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = NewDevtoolsService(devtoolsZQuerier{sessionErr: errors.New("read failed")}).
		WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "session-z", Kind: DevtoolsKindFileTree})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewDevtoolsService(devtoolsZQuerier{upsertErr: errors.New("write failed")}).
		WriteSnapshot(context.Background(), WriteSnapshotInput{SessionID: "session-z", Kind: DevtoolsKindFileTree})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewDevtoolsService(devtoolsZQuerier{snapshotErr: pgx.ErrNoRows}).
		GetSnapshot(context.Background(), "session-z", DevtoolsKindFileTree, 11)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	_, err = NewDevtoolsService(devtoolsZQuerier{snapshotErr: errors.New("lookup failed")}).
		GetSnapshot(context.Background(), "session-z", DevtoolsKindFileTree, 11)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = svc.GetSnapshot(context.Background(), "session-z", DevtoolsKindFileTree, 11)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}
