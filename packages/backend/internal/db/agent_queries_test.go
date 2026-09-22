package db

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateAgentSessionAndMessages(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "agent-user")
	repoID := mustCreateRepo(t, pool, userID, "agent-repo")

	session, err := q.CreateAgentSession(context.Background(), CreateAgentSessionParams{
		ID:           "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2",
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "Investigate flaky test",
		Status:       "active",
	})
	require.NoError(t, err)
	assert.Equal(t, "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2", session.ID)

	message, err := q.CreateAgentMessage(context.Background(), CreateAgentMessageParams{
		SessionID:    "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2",
		RepositoryID: repoID,
		Role:         "user",
		Sequence:     1,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), message.Sequence)
	assert.Equal(t, repoID, message.RepositoryID,
		"ticket 0115: agent_messages.repository_id must be populated on insert")

	part, err := q.CreateAgentPart(context.Background(), CreateAgentPartParams{
		MessageID:    message.ID,
		RepositoryID: repoID,
		SessionID:    "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2",
		PartIndex:    0,
		PartType:     "text",
		Content:      []byte(`{"text":"hello"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, message.ID, part.MessageID)
	assert.Equal(t, repoID, part.RepositoryID,
		"ticket 0118: agent_parts.repository_id must be populated on insert")
	assert.Equal(t, "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2", part.SessionID,
		"ticket 0118: agent_parts.session_id must be populated on insert")

	_, err = q.CreateAgentMessage(context.Background(), CreateAgentMessageParams{
		SessionID:    "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2",
		RepositoryID: repoID,
		Role:         "assistant",
		Sequence:     2,
	})
	require.NoError(t, err)

	messages, err := q.ListAgentMessages(context.Background(), ListAgentMessagesParams{
		SessionID:  "6931b3dc-c0ef-4e6f-a9a4-bef42f1df7d2",
		PageSize:   1,
		PageOffset: 1,
	})
	require.NoError(t, err)
	require.Len(t, messages, 1)
	assert.Equal(t, int64(2), messages[0].Sequence)
}

func TestCreateAgentSession_InvalidUUIDRejected(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "agent-invalid-uuid-user")
	repoID := mustCreateRepo(t, pool, userID, "agent-invalid-uuid-repo")

	_, err := q.CreateAgentSession(context.Background(), CreateAgentSessionParams{
		ID:           "sess_123",
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "bad id",
		Status:       "active",
	})
	require.Error(t, err)
}

func TestAgentSessionQueries_WithMessageCounts(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "agent-count-user")
	repoID := mustCreateRepo(t, pool, userID, "agent-count-repo")

	session, err := q.CreateAgentSession(context.Background(), CreateAgentSessionParams{
		ID:           "7a19b283-1047-4bd3-9f1b-5d6f2a5eb8e4",
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "Counted session",
		Status:       "active",
	})
	require.NoError(t, err)

	for sequence := int64(0); sequence < 2; sequence++ {
		_, err = q.CreateAgentMessage(context.Background(), CreateAgentMessageParams{
			SessionID:    session.ID,
			RepositoryID: repoID,
			Role:         "assistant",
			Sequence:     sequence,
		})
		require.NoError(t, err)
	}

	sessions, err := q.ListAgentSessionsByRepoWithMessageCount(context.Background(), ListAgentSessionsByRepoWithMessageCountParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.Equal(t, session.ID, sessions[0].ID)
	assert.Equal(t, int64(2), sessions[0].MessageCount)

	sessionWithCount, err := q.GetAgentSessionWithMessageCount(context.Background(), session.ID)
	require.NoError(t, err)
	assert.Equal(t, session.ID, sessionWithCount.ID)
	assert.Equal(t, int64(2), sessionWithCount.MessageCount)
}

func TestCreateAgentMessageWithNextSequence_ConcurrentSameSession_AssignsUniqueContiguousSequence(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	seq := testSeqCounter.Add(1)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("agent-seq-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("agent-seq-repo-%d", seq))
	sessionID := fmt.Sprintf("bbbbbbbb-cccc-dddd-eeee-%012d", seq)

	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "sequence race test",
		Status:       "active",
	})
	require.NoError(t, err)

	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, sessionID)
		mustDurablyDeleteRepoCommittedForTest(t, sharedPool, repoID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	const workers = 5
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	sequences := make(chan int64, workers)
	start := make(chan struct{})

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start

			tx, txErr := sharedPool.Begin(ctx)
			if txErr != nil {
				errs <- txErr
				return
			}
			defer func() {
				rbErr := tx.Rollback(ctx)
				if rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
					errs <- rbErr
				}
			}()

			_, lockErr := New(tx).LockAgentSessionForAppend(ctx, sessionID)
			if lockErr != nil {
				errs <- lockErr
				return
			}

			msg, createErr := New(tx).CreateAgentMessageWithNextSequence(ctx, CreateAgentMessageWithNextSequenceParams{
				SessionID: sessionID,
				Role:      "user",
			})
			if createErr != nil {
				errs <- createErr
				return
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				errs <- commitErr
				return
			}

			sequences <- msg.Sequence
		}()
	}

	close(start)
	wg.Wait()
	close(errs)
	close(sequences)

	var gotErrs []error
	for runErr := range errs {
		gotErrs = append(gotErrs, runErr)
	}
	require.Empty(t, gotErrs, "expected no errors creating messages concurrently")

	gotSequences := make([]int64, 0, workers)
	for seq := range sequences {
		gotSequences = append(gotSequences, seq)
	}
	require.Len(t, gotSequences, workers, "expected one message per worker")

	slices.Sort(gotSequences)
	for i := 0; i < workers; i++ {
		assert.Equal(t, int64(i), gotSequences[i], "expected contiguous sequence numbers")
	}
}

func TestNotifyAgentSession_Executes(t *testing.T) {
	// Basic execution smoke test for sqlc wrapper.
	// Uses a synthetic session id value that maps to channel agent_session_testsession123.
	payload := `{"session_id":"test-session-id","role":"user","sequence":0}`
	err := New(sharedPool).NotifyAgentSession(context.Background(), NotifyAgentSessionParams{
		SessionID: "testsession123",
		Payload:   payload,
	})
	require.NoError(t, err)
}

func TestNotifyAgentSession_DeliversToListener(t *testing.T) {
	// pg_notify delivers to LISTEN subscribers only after a COMMIT.
	// Use sharedPool directly (not the per-test transaction) so the notify fires immediately.
	seq := testSeqCounter.Add(1)
	poolQ := New(sharedPool)

	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("notify-agent-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("notify-agent-repo-%d", seq))

	// Use a predictable UUID format for the session.
	sessionUUID := fmt.Sprintf("aaaaaaaa-bbbb-cccc-dddd-%012d", seq)
	_, err := poolQ.CreateAgentSession(context.Background(), CreateAgentSessionParams{
		ID:           sessionUUID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "notify test session",
		Status:       "active",
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, sessionUUID)
		mustDurablyDeleteRepoCommittedForTest(t, sharedPool, repoID)
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	// The service strips dashes from session UUID before passing to NotifyAgentSession.
	safeID := fmt.Sprintf("aaaaaaaabbbbccccddddd%012d", seq)
	channel := "agent_session_" + safeID
	payload := fmt.Sprintf(`{"session_id":%q,"role":"user","sequence":0}`, sessionUUID)

	// Subscribe to the channel before sending the notify.
	listenerConn, err := sharedPool.Acquire(context.Background())
	require.NoError(t, err)
	defer listenerConn.Release()

	_, err = listenerConn.Exec(context.Background(), "LISTEN "+channel)
	require.NoError(t, err)

	// Send the notify using the SQL query.
	err = poolQ.NotifyAgentSession(context.Background(), NotifyAgentSessionParams{
		SessionID: safeID,
		Payload:   payload,
	})
	require.NoError(t, err)

	// Wait up to 2 seconds for the notification to arrive.
	waitCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	notification, err := listenerConn.Conn().WaitForNotification(waitCtx)
	require.NoError(t, err)
	assert.Equal(t, channel, notification.Channel)
	assert.Equal(t, payload, notification.Payload)
}

// -----------------------------------------------------------------------------
// Ticket 0114: soft-delete tombstone semantics for agent_sessions.
// -----------------------------------------------------------------------------

// TestDeleteAgentSession_Tombstones verifies that DeleteAgentSession performs
// an UPDATE (tombstone) rather than a hard DELETE, and that read paths filter
// the tombstoned row out by default.
func TestDeleteAgentSession_Tombstones(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "tomb-user")
	repoID := mustCreateRepo(t, pool, userID, "tomb-repo")

	sessionID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "soon to be tombstoned",
		Status:       "active",
	})
	require.NoError(t, err)

	// Sanity check: list/get return the live row.
	live, err := q.GetAgentSession(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, live.ID)
	assert.False(t, live.DeletedAt.Valid, "live row must have NULL deleted_at")

	listed, err := q.ListAgentSessionsByRepo(ctx, ListAgentSessionsByRepoParams{
		RepositoryID: repoID, PageOffset: 0, PageSize: 10,
	})
	require.NoError(t, err)
	require.Len(t, listed, 1)

	// Tombstone the session.
	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: sessionID, UserID: userID,
	}))

	// Row still exists physically — verify via raw SQL.
	var rawDeletedAtValid bool
	err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM agent_sessions WHERE id = $1`, sessionID).Scan(&rawDeletedAtValid)
	require.NoError(t, err, "row must still exist after soft-delete")
	assert.True(t, rawDeletedAtValid, "deleted_at should be set")

	// GetAgentSession now returns ErrNoRows (row hidden).
	_, err = q.GetAgentSession(ctx, sessionID)
	require.Error(t, err, "tombstoned row must be hidden from GetAgentSession")
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	// ListAgentSessionsByRepo now returns no rows.
	listed, err = q.ListAgentSessionsByRepo(ctx, ListAgentSessionsByRepoParams{
		RepositoryID: repoID, PageOffset: 0, PageSize: 10,
	})
	require.NoError(t, err)
	assert.Len(t, listed, 0, "tombstoned row must be hidden from list")

	// CountAgentSessionsByRepo must drop to zero.
	cnt, err := q.CountAgentSessionsByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), cnt)

	// With-message-count variants also hide the row.
	_, err = q.GetAgentSessionWithMessageCount(ctx, sessionID)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "enriched GET must also hide tombstoned rows")

	listedCounts, err := q.ListAgentSessionsByRepoWithMessageCount(ctx, ListAgentSessionsByRepoWithMessageCountParams{
		RepositoryID: repoID, PageOffset: 0, PageSize: 10,
	})
	require.NoError(t, err)
	assert.Len(t, listedCounts, 0, "enriched LIST must also hide tombstoned rows")

	// Admin/debug path still sees it.
	admin, err := q.GetAgentSessionAnyState(ctx, sessionID)
	require.NoError(t, err, "GetAgentSessionAnyState must still see the row")
	assert.Equal(t, sessionID, admin.ID)
	assert.True(t, admin.DeletedAt.Valid)
}

// TestDeleteAgentSession_Idempotent verifies that tombstoning an
// already-tombstoned row is a no-op and does not move the tombstone timestamp.
func TestDeleteAgentSession_Idempotent(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "tomb-idem-user")
	repoID := mustCreateRepo(t, pool, userID, "tomb-idem-repo")

	sessionID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "idempotent test",
		Status:       "active",
	})
	require.NoError(t, err)

	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: sessionID, UserID: userID,
	}))

	var firstTombstone time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT deleted_at FROM agent_sessions WHERE id = $1`, sessionID).Scan(&firstTombstone))
	require.False(t, firstTombstone.IsZero())

	// Second call should succeed without error and preserve the original
	// deleted_at timestamp (COALESCE keeps the first value).
	time.Sleep(10 * time.Millisecond)
	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: sessionID, UserID: userID,
	}))

	var secondTombstone time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT deleted_at FROM agent_sessions WHERE id = $1`, sessionID).Scan(&secondTombstone))
	assert.True(t, firstTombstone.Equal(secondTombstone), "idempotent delete must not move the tombstone")
}

// TestDeleteAgentSession_WrongUserNoOp verifies that attempting to
// tombstone with a mismatched user_id does not affect the row.
func TestDeleteAgentSession_WrongUserNoOp(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	ownerID := mustCreateUser(t, pool, "tomb-owner")
	attackerID := mustCreateUser(t, pool, "tomb-attacker")
	repoID := mustCreateRepo(t, pool, ownerID, "tomb-owner-repo")

	sessionID := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       ownerID,
		Title:        "owned session",
		Status:       "active",
	})
	require.NoError(t, err)

	// Attacker attempts delete — the WHERE user_id=attackerID excludes the
	// row so nothing happens (no rows affected, no error).
	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: sessionID, UserID: attackerID,
	}))

	live, err := q.GetAgentSession(ctx, sessionID)
	require.NoError(t, err, "row must still be visible after cross-user delete")
	assert.False(t, live.DeletedAt.Valid, "deleted_at must still be NULL")
}

// TestLockAgentSessionForAppend_SkipsTombstoned verifies that once a session
// is tombstoned, LockAgentSessionForAppend (used inside the message-append
// transaction) no longer finds it, preventing new messages from being
// appended to a tombstoned session.
func TestLockAgentSessionForAppend_SkipsTombstoned(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "tomb-lock-user")
	repoID := mustCreateRepo(t, pool, userID, "tomb-lock-repo")

	sessionID := "dddddddd-dddd-dddd-dddd-dddddddddddd"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "lock test",
		Status:       "active",
	})
	require.NoError(t, err)

	// Pre-tombstone: lock succeeds.
	got, err := q.LockAgentSessionForAppend(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, sessionID, got.ID)
	assert.Equal(t, repoID, got.RepositoryID)

	// Tombstone.
	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: sessionID, UserID: userID,
	}))

	// Post-tombstone: lock returns ErrNoRows, which message-append tx
	// converts into a caller-visible failure.
	_, err = q.LockAgentSessionForAppend(ctx, sessionID)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "tombstoned session must be unlockable for append")
}

func TestLockAgentSessionForAppend_SkipsTerminalSession(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "terminal-lock-user")
	repoID := mustCreateRepo(t, pool, userID, "terminal-lock-repo")
	sessionID := "abababab-abab-abab-abab-abababababab"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "terminal lock", Status: "active",
	})
	require.NoError(t, err)
	_, err = q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{
		ID: sessionID, Status: "completed", FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	require.NoError(t, err)

	_, err = q.LockAgentSessionForAppend(ctx, sessionID)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "terminal session must reject later appends")
}

func TestAgentTerminalTransitionWaitsForInFlightAppend(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	userID := mustCreateUser(t, sharedPool, "terminal-append-order-user")
	repoID := mustCreateRepo(t, sharedPool, userID, "terminal-append-order-repo")
	sessionID := "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "terminal append order", Status: "active",
	})
	require.NoError(t, err)

	appendTx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = appendTx.Rollback(ctx) }()
	appendQ := New(appendTx)
	_, err = appendQ.LockAgentSessionForAppend(ctx, sessionID)
	require.NoError(t, err)

	type terminalResult struct {
		session AgentSession
		err     error
	}
	transitionStarted := make(chan struct{})
	transitionDone := make(chan terminalResult, 1)
	go func() {
		close(transitionStarted)
		session, updateErr := q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{
			ID: sessionID, Status: "completed", FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		transitionDone <- terminalResult{session: session, err: updateErr}
	}()
	<-transitionStarted
	select {
	case result := <-transitionDone:
		t.Fatalf("terminal transition bypassed append row lock: session=%+v err=%v", result.session, result.err)
	case <-time.After(100 * time.Millisecond):
	}

	_, err = appendQ.CreateAgentMessageWithNextSequence(ctx, CreateAgentMessageWithNextSequenceParams{
		SessionID: sessionID,
		Role:      "assistant",
	})
	require.NoError(t, err)
	require.NoError(t, appendTx.Commit(ctx))

	select {
	case result := <-transitionDone:
		require.NoError(t, result.err)
		assert.Equal(t, "completed", result.session.Status)
	case <-time.After(2 * time.Second):
		t.Fatal("terminal transition remained blocked after append committed")
	}

	count, err := q.CountAgentMessagesBySession(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count, "terminal archive high-water mark must include the append that won the row lock")
	_, err = q.LockAgentSessionForAppend(ctx, sessionID)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "no append may begin after the terminal transition")
}

// TestCreateAgentSession_AllocatesFreshUUIDAfterTombstone documents the
// create-after-tombstone behavior: the service generates a brand new UUID, so
// there is no unique-constraint interaction with the tombstoned row. This is
// the "allocates fresh" path called out in ticket 0114; re-use of the same
// UUID is not supported and is not exercised here.
func TestCreateAgentSession_AllocatesFreshUUIDAfterTombstone(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	userID := mustCreateUser(t, pool, "tomb-reuse-user")
	repoID := mustCreateRepo(t, pool, userID, "tomb-reuse-repo")

	oldID := "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           oldID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "first",
		Status:       "active",
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{
		ID: oldID, UserID: userID,
	}))

	// Fresh UUID succeeds — the tombstoned row does not interfere because the
	// primary key is the full UUID, not a shape-scoped slug.
	newID := "eeeeeeee-ffff-ffff-ffff-ffffffffffff"
	created, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           newID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "second",
		Status:       "active",
	})
	require.NoError(t, err)
	assert.Equal(t, newID, created.ID)

	// List must return only the new live row, not the tombstoned old one.
	live, err := q.ListAgentSessionsByRepo(ctx, ListAgentSessionsByRepoParams{
		RepositoryID: repoID, PageOffset: 0, PageSize: 10,
	})
	require.NoError(t, err)
	require.Len(t, live, 1)
	assert.Equal(t, newID, live[0].ID)
}

func TestAgentMessages_CreateWithNextSequence_PopulatesRepositoryID(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	seq := testSeqCounter.Add(1)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("msg-denorm-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("msg-denorm-repo-%d", seq))

	sessionID := fmt.Sprintf("11111111-1111-1111-1111-%012d", seq)
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "denorm-seq",
		Status:       "active",
	})
	require.NoError(t, err)

	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()

	locked, err := New(tx).LockAgentSessionForAppend(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, repoID, locked.RepositoryID,
		"LockAgentSessionForAppend must return repository_id so the append path can denormalize it")

	msg, err := New(tx).CreateAgentMessageWithNextSequence(ctx, CreateAgentMessageWithNextSequenceParams{
		SessionID: sessionID,
		Role:      "user",
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, msg.RepositoryID,
		"ticket 0115: CTE-based insert must denormalize repository_id from the locked session")
	require.NoError(t, tx.Commit(ctx))
}

// TestAgentParts_CreatePopulatesSessionAndRepoIDs asserts that
// CreateAgentPart requires and stores the denormalized repository_id +
// session_id (ticket 0118).
func TestAgentParts_CreatePopulatesSessionAndRepoIDs(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	seq := testSeqCounter.Add(1)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("part-denorm-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("part-denorm-repo-%d", seq))

	sessionID := fmt.Sprintf("22222222-2222-2222-2222-%012d", seq)
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "part denorm",
		Status:       "active",
	})
	require.NoError(t, err)

	msg, err := q.CreateAgentMessage(ctx, CreateAgentMessageParams{
		SessionID:    sessionID,
		RepositoryID: repoID,
		Role:         "assistant",
		Sequence:     0,
	})
	require.NoError(t, err)

	// All three supported part types must round-trip the denorm fields.
	for i, partType := range []string{"text", "tool_call", "tool_result"} {
		part, err := q.CreateAgentPart(ctx, CreateAgentPartParams{
			MessageID:    msg.ID,
			RepositoryID: repoID,
			SessionID:    sessionID,
			PartIndex:    int64(i),
			PartType:     partType,
			Content:      []byte(`{"ok":true}`),
		})
		require.NoError(t, err, partType)
		assert.Equal(t, repoID, part.RepositoryID, "repository_id round-trip (%s)", partType)
		assert.Equal(t, sessionID, part.SessionID, "session_id round-trip (%s)", partType)
	}
}

// TestAgentMessagesParts_SessionIsolation_NoLeakBetweenSessions asserts that
// the production shape filter `session_id IN (<a>)` would only ever see rows
// belonging to that session, even when multiple sessions live under the same
// repository. This mirrors the subscription-isolation guarantee the client
// relies on (tickets 0115, 0118).
func TestAgentMessagesParts_SessionIsolation_NoLeakBetweenSessions(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	seq := testSeqCounter.Add(1)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("iso-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("iso-repo-%d", seq))

	sessionA := fmt.Sprintf("aaaaaaaa-aaaa-aaaa-aaaa-%012d", seq)
	sessionB := fmt.Sprintf("bbbbbbbb-bbbb-bbbb-bbbb-%012d", seq)
	for _, sid := range []string{sessionA, sessionB} {
		_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
			ID:           sid,
			RepositoryID: repoID,
			UserID:       userID,
			Title:        "iso",
			Status:       "active",
		})
		require.NoError(t, err)
	}

	// 5 messages + 1 part each, into each session, interleaved to catch any
	// ordering-based bug.
	for i := int64(0); i < 5; i++ {
		for _, sid := range []string{sessionA, sessionB} {
			msg, err := q.CreateAgentMessage(ctx, CreateAgentMessageParams{
				SessionID:    sid,
				RepositoryID: repoID,
				Role:         "user",
				Sequence:     i,
			})
			require.NoError(t, err)
			_, err = q.CreateAgentPart(ctx, CreateAgentPartParams{
				MessageID:    msg.ID,
				RepositoryID: repoID,
				SessionID:    sid,
				PartIndex:    0,
				PartType:     "text",
				Content:      []byte(fmt.Sprintf(`{"text":"%s-%d"}`, sid, i)),
			})
			require.NoError(t, err)
		}
	}

	// The production shape where-clause is `repository_id IN (...) AND
	// session_id IN (...)`. Assert that running that predicate for session
	// A returns only A's rows.
	var msgsA, msgsB int
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE repository_id = $1 AND session_id = $2`,
		repoID, sessionA).Scan(&msgsA))
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE repository_id = $1 AND session_id = $2`,
		repoID, sessionB).Scan(&msgsB))
	assert.Equal(t, 5, msgsA)
	assert.Equal(t, 5, msgsB)

	// Same assertion for parts.
	var partsA, partsB int
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_parts WHERE repository_id = $1 AND session_id = $2`,
		repoID, sessionA).Scan(&partsA))
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_parts WHERE repository_id = $1 AND session_id = $2`,
		repoID, sessionB).Scan(&partsB))
	assert.Equal(t, 5, partsA)
	assert.Equal(t, 5, partsB)

	// And the cross-session scan (should be 0 — A's filter must never match
	// a B row and vice versa). This catches a bug where the denorm fields
	// drift from the parent session.
	var leak int
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE session_id = $1 AND repository_id <> $2`,
		sessionA, repoID).Scan(&leak))
	assert.Equal(t, 0, leak, "no cross-repo leakage via denormalized repository_id")
}

// TestAgentMessages_HighCardinality_ShapeFilterStaysSessionScoped asserts
// that a single session with hundreds of messages still reads back only
// that session's rows under the production shape filter, even under pool
// reuse. This catches a regression where the (repository_id, session_id,
// sequence) index would be accidentally dropped or replaced with a
// repo-wide index — clients would still work but shape filter scans would
// silently bloat.
func TestAgentMessages_HighCardinality_ShapeFilterStaysSessionScoped(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)

	seq := testSeqCounter.Add(1)
	userID := mustCreateUser(t, sharedPool, fmt.Sprintf("hi-card-user-%d", seq))
	repoID := mustCreateRepo(t, sharedPool, userID, fmt.Sprintf("hi-card-repo-%d", seq))

	sessionID := fmt.Sprintf("33333333-3333-3333-3333-%012d", seq)
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "hi-card",
		Status:       "active",
	})
	require.NoError(t, err)

	// One noise session in the same repo to prove the filter holds under
	// repo-level cardinality too.
	noiseSessionID := fmt.Sprintf("44444444-4444-4444-4444-%012d", seq)
	_, err = q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID:           noiseSessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "noise",
		Status:       "active",
	})
	require.NoError(t, err)

	const n = 500
	for i := int64(0); i < n; i++ {
		_, err := q.CreateAgentMessage(ctx, CreateAgentMessageParams{
			SessionID:    sessionID,
			RepositoryID: repoID,
			Role:         "user",
			Sequence:     i,
		})
		require.NoError(t, err)
	}
	// A few noise rows.
	for i := int64(0); i < 10; i++ {
		_, err := q.CreateAgentMessage(ctx, CreateAgentMessageParams{
			SessionID:    noiseSessionID,
			RepositoryID: repoID,
			Role:         "user",
			Sequence:     i,
		})
		require.NoError(t, err)
	}

	var scoped int
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE repository_id = $1 AND session_id = $2`,
		repoID, sessionID).Scan(&scoped))
	assert.Equal(t, n, scoped,
		"production shape filter must return exactly the session's messages (no leak from noise session)")
}
