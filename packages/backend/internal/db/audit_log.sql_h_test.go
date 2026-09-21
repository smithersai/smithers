package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type auditLogSQLHDB = chunk4SQLHDB
type auditLogSQLHRow = chunk4SQLHRow
type auditLogSQLHRows = chunk4SQLHRows

func TestAuditLogSQL_H_ListFilterPublicAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	actorID, publicRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	_, privateRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	mustExec(t, pool, `UPDATE repositories SET is_public = FALSE WHERE id = $1`, privateRepoID)
	since := time.Now().Add(-time.Hour)

	require.NoError(t, q.InsertAuditLog(ctx, auditLogSQLHParams(actorID, "repo.created", publicRepoID, "public-repo", "create")))
	require.NoError(t, q.InsertAuditLog(ctx, auditLogSQLHParams(actorID, "repo.deleted", privateRepoID, "private-repo", "delete")))
	require.NoError(t, q.InsertAuditLog(ctx, InsertAuditLogParams{
		EventType:  "approval.decided",
		ActorID:    pgtype.Int8{Int64: actorID, Valid: true},
		ActorName:  "actor",
		TargetType: "approval",
		TargetName: "approval-1",
		Action:     "decide",
		Metadata:   json.RawMessage(`{"decision":"approved"}`),
		IpAddress:  "127.0.0.1",
	}))

	all, err := q.ListAuditLogs(ctx, ListAuditLogsParams{Since: since, PageOffset: 0, PageLimit: 10})
	require.NoError(t, err)
	require.Len(t, all, 3)
	byActor, err := q.ListAuditLogsByActor(ctx, ListAuditLogsByActorParams{ActorID: pgtype.Int8{Int64: actorID, Valid: true}, Since: since, PageOffset: 0, PageLimit: 10})
	require.NoError(t, err)
	require.Len(t, byActor, 3)
	filtered, err := q.ListAuditLogsFiltered(ctx, ListAuditLogsFilteredParams{
		Since: since, EventType: "approval.decided", TargetType: "approval", TargetName: "approval-1", ActorID: actorID, PageOffset: 0, PageLimit: 10,
	})
	require.NoError(t, err)
	require.Len(t, filtered, 1)
	assert.Equal(t, "approval.decided", filtered[0].EventType)

	publicCount, err := q.CountPublicAuditLogsByActor(ctx, CountPublicAuditLogsByActorParams{ActorID: pgtype.Int8{Int64: actorID, Valid: true}, Since: since})
	require.NoError(t, err)
	assert.Equal(t, int64(1), publicCount)
	publicLogs, err := q.ListPublicAuditLogsByActor(ctx, ListPublicAuditLogsByActorParams{ActorID: pgtype.Int8{Int64: actorID, Valid: true}, Since: since, PageOffset: 0, PageLimit: 10})
	require.NoError(t, err)
	require.Len(t, publicLogs, 1)
	assert.Equal(t, publicRepoID, publicLogs[0].TargetID.Int64)

	empty, err := q.ListAuditLogs(ctx, ListAuditLogsParams{Since: time.Now().Add(time.Hour), PageOffset: 0, PageLimit: 10})
	require.NoError(t, err)
	assert.Empty(t, empty)

	require.NoError(t, q.InsertAuditLog(ctx, auditLogSQLHParams(actorID, "repo.old", publicRepoID, "old-repo", "old")))
	mustExec(t, pool, `UPDATE audit_log SET created_at = $1 WHERE event_type = 'repo.old'`, time.Now().Add(-48*time.Hour))
	require.NoError(t, q.DeleteAuditLogsOlderThan(ctx, time.Now().Add(-24*time.Hour)))
	oldRows, err := q.ListAuditLogsFiltered(ctx, ListAuditLogsFilteredParams{Since: time.Now().Add(-72 * time.Hour), EventType: "repo.old", PageOffset: 0, PageLimit: 10})
	require.NoError(t, err)
	assert.Empty(t, oldRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		return spQ.InsertAuditLog(ctx, InsertAuditLogParams{
			EventType: "repo.bad", ActorID: pgtype.Int8{Int64: 999999, Valid: true}, ActorName: "bad", TargetType: "repository", Action: "bad", Metadata: json.RawMessage(`{}`),
		})
	})
}

func TestAuditLogSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("audit log h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAuditLogs", func(q *Queries) error {
			_, err := q.ListAuditLogs(context.Background(), ListAuditLogsParams{Since: time.Now(), PageLimit: 1})
			return err
		}},
		{"ListAuditLogsByActor", func(q *Queries) error {
			_, err := q.ListAuditLogsByActor(context.Background(), ListAuditLogsByActorParams{Since: time.Now(), PageLimit: 1})
			return err
		}},
		{"ListAuditLogsFiltered", func(q *Queries) error {
			_, err := q.ListAuditLogsFiltered(context.Background(), ListAuditLogsFilteredParams{Since: time.Now(), PageLimit: 1})
			return err
		}},
		{"ListPublicAuditLogsByActor", func(q *Queries) error {
			_, err := q.ListPublicAuditLogsByActor(context.Background(), ListPublicAuditLogsByActorParams{Since: time.Now(), PageLimit: 1})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(auditLogSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(auditLogSQLHDB{rows: &auditLogSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(auditLogSQLHDB{rows: &auditLogSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestAuditLogSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("audit log h failed")
	rowQ := New(auditLogSQLHDB{row: auditLogSQLHRow{err: sentinel}})
	_, err := rowQ.CountPublicAuditLogsByActor(context.Background(), CountPublicAuditLogsByActorParams{})
	require.ErrorIs(t, err, sentinel)

	execQ := New(auditLogSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteAuditLogsOlderThan(context.Background(), time.Now()), sentinel)
	require.ErrorIs(t, execQ.InsertAuditLog(context.Background(), InsertAuditLogParams{}), sentinel)
}

func auditLogSQLHParams(actorID int64, eventType string, repoID int64, targetName, action string) InsertAuditLogParams {
	return InsertAuditLogParams{
		EventType:  eventType,
		ActorID:    pgtype.Int8{Int64: actorID, Valid: true},
		ActorName:  "actor",
		TargetType: "repository",
		TargetID:   pgtype.Int8{Int64: repoID, Valid: true},
		TargetName: targetName,
		Action:     action,
		Metadata:   json.RawMessage(`{"source":"h"}`),
		IpAddress:  "127.0.0.1",
	}
}
