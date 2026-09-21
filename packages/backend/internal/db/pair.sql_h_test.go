package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type pairSQLHDB = chunk4SQLHDB
type pairSQLHRow = chunk4SQLHRow
type pairSQLHRows = chunk4SQLHRows

func TestPairSQL_H_StateLinksNotifyAndRevoke(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))
	roomID := "room-" + randSlug(t)

	require.NoError(t, q.UpsertPairState(ctx, UpsertPairStateParams{
		RoomID:  roomID,
		State:   json.RawMessage(`{"phase":"draft"}`),
		Version: 1,
	}))
	state, err := q.GetPairState(ctx, roomID)
	require.NoError(t, err)
	assert.JSONEq(t, `{"phase":"draft"}`, string(state.State))
	assert.Equal(t, int64(1), state.Version)
	locked, err := q.GetPairStateForUpdate(ctx, roomID)
	require.NoError(t, err)
	assert.Equal(t, state.Version, locked.Version)

	require.NoError(t, q.UpsertPairState(ctx, UpsertPairStateParams{
		RoomID:  roomID,
		State:   json.RawMessage(`{"phase":"running"}`),
		Version: 2,
	}))
	state, err = q.GetPairState(ctx, roomID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), state.Version)
	_, err = q.GetPairState(ctx, "missing-"+randSlug(t))
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPairStateForUpdate(ctx, "missing-"+randSlug(t))
	require.ErrorIs(t, err, pgx.ErrNoRows)

	link, err := q.CreatePairShareLink(ctx, CreatePairShareLinkParams{
		TokenHash: "tok-" + randSlug(t),
		RoomID:    roomID,
		Level:     "edit",
		CreatedBy: userID,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	found, err := q.GetPairShareLinkByTokenHash(ctx, link.TokenHash)
	require.NoError(t, err)
	assert.Equal(t, link.ID, found.ID)
	links, err := q.ListPairShareLinksByRoom(ctx, roomID)
	require.NoError(t, err)
	require.Len(t, links, 1)
	assert.Equal(t, link.ID, links[0].ID)

	require.NoError(t, q.NotifyPairRoom(ctx, NotifyPairRoomParams{RoomID: roomID, Payload: `{"ok":true}`}))
	affected, err := q.RevokePairShareLink(ctx, RevokePairShareLinkParams{ID: link.ID, CreatedBy: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), affected)
	affected, err = q.RevokePairShareLink(ctx, RevokePairShareLinkParams{ID: link.ID, CreatedBy: userID})
	require.NoError(t, err)
	assert.Zero(t, affected)
	_, err = q.GetPairShareLinkByTokenHash(ctx, link.TokenHash)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	links, err = q.ListPairShareLinksByRoom(ctx, roomID)
	require.NoError(t, err)
	assert.Empty(t, links)

	expired, err := q.CreatePairShareLink(ctx, CreatePairShareLinkParams{
		TokenHash: "expired-" + randSlug(t),
		RoomID:    roomID,
		Level:     "view",
		CreatedBy: userID,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true},
	})
	require.NoError(t, err)
	_, err = q.GetPairShareLinkByTokenHash(ctx, expired.TokenHash)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreatePairShareLink(ctx, CreatePairShareLinkParams{
			TokenHash: link.TokenHash,
			RoomID:    roomID,
			Level:     "view",
			CreatedBy: userID,
		})
		return err
	})
}

func TestPairSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("pair h rows failed")
	call := func(q *Queries) error {
		_, err := q.ListPairShareLinksByRoom(context.Background(), "room")
		return err
	}
	require.ErrorIs(t, call(New(pairSQLHDB{queryErr: sentinel})), sentinel)
	require.ErrorIs(t, call(New(pairSQLHDB{rows: &pairSQLHRows{next: true, scanErr: sentinel}})), sentinel)
	require.ErrorIs(t, call(New(pairSQLHDB{rows: &pairSQLHRows{err: sentinel}})), sentinel)
}

func TestPairSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("pair h failed")
	rowQ := New(pairSQLHDB{row: pairSQLHRow{err: sentinel}})
	_, err := rowQ.CreatePairShareLink(context.Background(), CreatePairShareLinkParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetPairShareLinkByTokenHash(context.Background(), "token")
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetPairState(context.Background(), "room")
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.GetPairStateForUpdate(context.Background(), "room")
	require.ErrorIs(t, err, sentinel)

	execQ := New(pairSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.NotifyPairRoom(context.Background(), NotifyPairRoomParams{}), sentinel)
	_, err = execQ.RevokePairShareLink(context.Background(), RevokePairShareLinkParams{})
	require.ErrorIs(t, err, sentinel)
	require.ErrorIs(t, execQ.UpsertPairState(context.Background(), UpsertPairStateParams{}), sentinel)
}
