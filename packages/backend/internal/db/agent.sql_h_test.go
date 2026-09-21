package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentSQL_H_SessionsMessagesAndPartsRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	sessionID := uuid.NewString()

	session, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "Agent H", Status: "active"})
	require.NoError(t, err)
	assert.Equal(t, "active", session.Status)

	count, err := q.CountAgentMessagesBySession(ctx, sessionID)
	require.NoError(t, err)
	assert.Zero(t, count)
	next, err := q.GetNextAgentMessageSequence(ctx, sessionID)
	require.NoError(t, err)
	assert.Zero(t, next)
	workflowRunID, err := q.GetAgentSessionWorkflowRunID(ctx, sessionID)
	require.NoError(t, err)
	assert.False(t, workflowRunID.Valid)

	startedAt := time.Now().Add(-2 * time.Hour)
	started, err := q.UpdateAgentSessionStartedAt(ctx, UpdateAgentSessionStartedAtParams{
		ID:        sessionID,
		StartedAt: pgtype.Timestamptz{Time: startedAt, Valid: true},
	})
	require.NoError(t, err)
	assert.True(t, started.StartedAt.Valid)

	def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "agent-h",
		Path:         ".smithers/workflows/agent-h-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{"steps":[{"name":"agent"}]}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "agent",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-agent-h",
		DispatchInputs:       json.RawMessage(`{"agent":true}`),
	})
	require.NoError(t, err)
	withRun, err := q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{
		WorkflowRunID: pgtype.Int8{Int64: run.ID, Valid: true},
		ID:            sessionID,
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, withRun.WorkflowRunID.Int64)
	workflowRunID, err = q.GetAgentSessionWorkflowRunID(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, run.ID, workflowRunID.Int64)

	msg1, err := q.CreateAgentMessageWithNextSequence(ctx, CreateAgentMessageWithNextSequenceParams{Role: "user", SessionID: sessionID})
	require.NoError(t, err)
	msg2, err := q.CreateAgentMessageWithNextSequence(ctx, CreateAgentMessageWithNextSequenceParams{Role: "assistant", SessionID: sessionID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), msg2.Sequence)

	count, err = q.CountAgentMessagesBySession(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
	next, err = q.GetNextAgentMessageSequence(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, int32(2), next)

	part1, err := q.CreateAgentPart(ctx, CreateAgentPartParams{
		MessageID: msg1.ID, RepositoryID: repoID, SessionID: sessionID, PartIndex: 0, PartType: "text", Content: json.RawMessage(`{"text":"hello"}`),
	})
	require.NoError(t, err)
	part2, err := q.CreateAgentPart(ctx, CreateAgentPartParams{
		MessageID: msg1.ID, RepositoryID: repoID, SessionID: sessionID, PartIndex: 1, PartType: "tool", Content: json.RawMessage(`{"name":"search"}`),
	})
	require.NoError(t, err)
	parts, err := q.ListAgentMessageParts(ctx, msg1.ID)
	require.NoError(t, err)
	require.Len(t, parts, 2)
	assert.Equal(t, part1.ID, parts[0].ID)
	assert.Equal(t, part2.ID, parts[1].ID)

	messages, err := q.ListAgentMessages(ctx, ListAgentMessagesParams{SessionID: sessionID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, messages, 2)
	assert.Equal(t, msg1.ID, messages[0].ID)
	after, err := q.ListAgentMessagesAfterID(ctx, ListAgentMessagesAfterIDParams{SessionID: sessionID, AfterID: msg1.ID, MaxResults: 10})
	require.NoError(t, err)
	require.Len(t, after, 1)
	assert.Equal(t, msg2.ID, after[0].ID)

	sessions, err := q.ListAgentSessionsByRepo(ctx, ListAgentSessionsByRepoParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	withCounts, err := q.ListAgentSessionsByRepoWithMessageCount(ctx, ListAgentSessionsByRepoWithMessageCountParams{RepositoryID: repoID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, withCounts, 1)
	assert.Equal(t, int64(2), withCounts[0].MessageCount)

	stale, err := q.ListStaleActiveSessions(ctx, pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true})
	require.NoError(t, err)
	require.NotEmpty(t, stale)
	assert.True(t, agentSQLHHasSession(stale, sessionID))

	sameStatus, err := q.UpdateAgentSessionStatus(ctx, UpdateAgentSessionStatusParams{ID: sessionID, Status: "active"})
	require.NoError(t, err)
	assert.Equal(t, "active", sameStatus.Status)
	require.NoError(t, q.NotifyAgentMessage(ctx, NotifyAgentMessageParams{SessionID: sessionID, Payload: `{"message":1}`}))

	finishedAt := pgtype.Timestamptz{Time: time.Now(), Valid: true}
	completed, err := q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{ID: sessionID, Status: "completed", FinishedAt: finishedAt})
	require.NoError(t, err)
	assert.Equal(t, "completed", completed.Status)
	assert.True(t, completed.FinishedAt.Valid)
	_, err = q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{ID: sessionID, Status: "failed", FinishedAt: finishedAt})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	timedOutID := uuid.NewString()
	_, err = q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: timedOutID, RepositoryID: repoID, UserID: userID, Title: "Timeout H", Status: "active"})
	require.NoError(t, err)
	timedOut, err := q.UpdateAgentSessionTimedOut(ctx, UpdateAgentSessionTimedOutParams{ID: timedOutID, FinishedAt: finishedAt})
	require.NoError(t, err)
	assert.Equal(t, "timed_out", timedOut.Status)

	missingSession := uuid.NewString()
	count, err = q.CountAgentMessagesBySession(ctx, missingSession)
	require.NoError(t, err)
	assert.Zero(t, count)
	next, err = q.GetNextAgentMessageSequence(ctx, missingSession)
	require.NoError(t, err)
	assert.Zero(t, next)
	emptyMessages, err := q.ListAgentMessages(ctx, ListAgentMessagesParams{SessionID: missingSession, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyMessages)
	emptyParts, err := q.ListAgentMessageParts(ctx, 999999)
	require.NoError(t, err)
	assert.Empty(t, emptyParts)
	_, err = q.GetAgentSessionWorkflowRunID(ctx, missingSession)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateAgentSessionStartedAt(ctx, UpdateAgentSessionStartedAtParams{ID: missingSession, StartedAt: finishedAt})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateAgentSessionStatus(ctx, UpdateAgentSessionStatusParams{ID: missingSession, Status: "failed"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{ID: missingSession})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdateAgentSessionTimedOut(ctx, UpdateAgentSessionTimedOutParams{ID: missingSession, FinishedAt: finishedAt})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateAgentSession(ctx, CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: repoID, UserID: userID, Title: "bad", Status: "paused"})
		return err
	})
	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateAgentPart(ctx, CreateAgentPartParams{
			MessageID: msg2.ID, RepositoryID: repoID, SessionID: sessionID, PartIndex: 0, PartType: "bad", Content: json.RawMessage(`[]`),
		})
		return err
	})
}

func TestAgentSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("agent h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAgentMessageParts", func(q *Queries) error { _, err := q.ListAgentMessageParts(context.Background(), 1); return err }},
		{"ListAgentMessages", func(q *Queries) error {
			_, err := q.ListAgentMessages(context.Background(), ListAgentMessagesParams{SessionID: uuid.NewString(), PageSize: 1})
			return err
		}},
		{"ListAgentMessagesAfterID", func(q *Queries) error {
			_, err := q.ListAgentMessagesAfterID(context.Background(), ListAgentMessagesAfterIDParams{SessionID: uuid.NewString(), MaxResults: 1})
			return err
		}},
		{"ListAgentSessionsByRepo", func(q *Queries) error {
			_, err := q.ListAgentSessionsByRepo(context.Background(), ListAgentSessionsByRepoParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListAgentSessionsByRepoWithMessageCount", func(q *Queries) error {
			_, err := q.ListAgentSessionsByRepoWithMessageCount(context.Background(), ListAgentSessionsByRepoWithMessageCountParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListStaleActiveSessions", func(q *Queries) error {
			_, err := q.ListStaleActiveSessions(context.Background(), pgtype.Timestamptz{Time: time.Now(), Valid: true})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(agentSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(agentSQLHDB{rows: &agentSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(agentSQLHDB{rows: &agentSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestAgentSQL_H_QueryRowErrorBranches(t *testing.T) {
	sentinel := errors.New("agent h row failed")
	q := New(agentSQLHDB{row: agentSQLHRow{err: sentinel}})

	_, err := q.CountAgentMessagesBySession(context.Background(), uuid.NewString())
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetAgentSessionWorkflowRunID(context.Background(), uuid.NewString())
	require.ErrorIs(t, err, sentinel)
	_, err = q.GetNextAgentMessageSequence(context.Background(), uuid.NewString())
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateAgentSessionStartedAt(context.Background(), UpdateAgentSessionStartedAtParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateAgentSessionStatus(context.Background(), UpdateAgentSessionStatusParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateAgentSessionTerminalStatus(context.Background(), UpdateAgentSessionTerminalStatusParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateAgentSessionTimedOut(context.Background(), UpdateAgentSessionTimedOutParams{})
	require.ErrorIs(t, err, sentinel)
	_, err = q.UpdateAgentSessionWorkflowRun(context.Background(), UpdateAgentSessionWorkflowRunParams{})
	require.ErrorIs(t, err, sentinel)
}

func TestAgentSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("agent h exec failed")
	q := New(agentSQLHDB{execErr: sentinel})
	require.ErrorIs(t, q.NotifyAgentMessage(context.Background(), NotifyAgentMessageParams{SessionID: uuid.NewString(), Payload: "{}"}), sentinel)
}

func agentSQLHHasSession(sessions []AgentSession, id string) bool {
	for _, session := range sessions {
		if session.ID == id {
			return true
		}
	}
	return false
}

type agentSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db agentSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db agentSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &agentSQLHRows{}, nil
}

func (db agentSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return agentSQLHRow{err: errors.New("agent h row failed")}
}

type agentSQLHRow struct {
	err error
}

func (r agentSQLHRow) Scan(...any) error {
	return r.err
}

type agentSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *agentSQLHRows) Close() {}

func (r *agentSQLHRows) Err() error {
	return r.err
}

func (r *agentSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *agentSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *agentSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *agentSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("agent h scan unexpectedly succeeded")
}

func (r *agentSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *agentSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *agentSQLHRows) Conn() *pgx.Conn {
	return nil
}
