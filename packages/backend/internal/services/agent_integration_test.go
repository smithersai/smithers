package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// setupTestPool returns the shared pool from TestMain, or skips the test.
func setupTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return servicesSuite.Pool(t)
}

// setupTestUserAndRepo creates a test user and repo for agent session tests.
func setupTestUserAndRepo(t *testing.T, pool *pgxpool.Pool) (userID int64, repoID int64) {
	ctx := context.Background()

	// Create user
	var uid int64
	username := fmt.Sprintf("testuser_%d", time.Now().UnixNano())
	email := fmt.Sprintf("test%d@test.com", time.Now().UnixNano())
	err := pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) 
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		strings.ToLower(username),
		email,
		strings.ToLower(email),
		"Test User",
	).Scan(&uid)
	require.NoError(t, err)

	// Create repo
	var rid int64
	lowerName := fmt.Sprintf("testrepo_%d", time.Now().UnixNano())
	err = pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number)
		 VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		uid, lowerName, lowerName,
	).Scan(&rid)
	require.NoError(t, err)

	return uid, rid
}

// TestAgentService_AppendMessage_ConcurrentSameSession_AssignsUniqueContiguousSequence
// launches multiple concurrent AppendMessage calls for the same session and verifies
// that:
//   - No caller receives unique-constraint failure
//   - Persisted rows in agent_messages have unique contiguous sequences
//   - Message parts are persisted for each created message
func TestAgentService_AppendMessage_ConcurrentSameSession_AssignsUniqueContiguousSequence(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping DB integration test in short mode")
	}
	pool := setupTestPool(t)
	queries := db.New(pool)

	// Create test user and repo
	uid, repoID := setupTestUserAndRepo(t, pool)

	// Create agent session
	ctx := context.Background()
	sessionID := uuid.New().String()
	_, err := queries.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       uid,
		Title:        "Concurrent Test Session",
		Status:       "active",
	})
	require.NoError(t, err)

	// Create service with transaction support
	service := NewAgentServiceWithPool(queries, pool)

	// Launch concurrent append operations
	const numGoroutines = 5
	var wg sync.WaitGroup
	errorsChan := make(chan error, numGoroutines)
	results := make(chan AgentMessageResponse, numGoroutines)

	// Use a barrier to synchronize goroutine start
	barrier := make(chan struct{})

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()

			// Wait for barrier signal to maximize concurrency
			<-barrier

			parts := []db.CreateAgentPartParams{
				{PartType: "text", Content: json.RawMessage(fmt.Sprintf(`{"value":"message %d"}`, idx))},
			}
			msg, err := service.AppendMessage(ctx, sessionID, "user", parts)
			if err != nil {
				errorsChan <- fmt.Errorf("goroutine %d: %w", idx, err)
				return
			}
			results <- msg
		}(i)
	}

	// Release all goroutines simultaneously
	close(barrier)
	wg.Wait()
	close(errorsChan)
	close(results)

	// Check for errors
	var errCount int
	for err := range errorsChan {
		t.Logf("Error: %v", err)
		errCount++
	}
	require.Zero(t, errCount, "expected no errors from concurrent appends")

	// Collect sequences and verify uniqueness/contiguity
	var messages []AgentMessageResponse
	for msg := range results {
		messages = append(messages, msg)
	}
	require.Len(t, messages, numGoroutines, "expected all messages to be created")

	// Extract and sort sequences
	sequences := make(map[int64]bool)
	for _, msg := range messages {
		sequences[msg.Sequence] = true
	}

	// Verify in-memory sequences are unique and contiguous (0 to numGoroutines-1)
	for i := int64(0); i < numGoroutines; i++ {
		assert.True(t, sequences[i], "expected sequence %d to exist", i)
	}
	assert.Len(t, sequences, numGoroutines, "expected unique sequences")

	// Verify persisted DB sequences match (not just in-memory results)
	persistedMsgs, err := queries.ListAgentMessages(ctx, db.ListAgentMessagesParams{
		SessionID:  sessionID,
		PageSize:   100,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, persistedMsgs, numGoroutines, "expected all messages persisted in DB")
	persistedSeqs := make(map[int64]bool)
	for _, m := range persistedMsgs {
		persistedSeqs[m.Sequence] = true
	}
	for i := int64(0); i < numGoroutines; i++ {
		assert.True(t, persistedSeqs[i], "expected persisted sequence %d to exist", i)
	}

	// Verify all parts are persisted
	for _, msg := range messages {
		parts, err := queries.ListAgentMessageParts(ctx, msg.ID)
		require.NoError(t, err)
		assert.Len(t, parts, 1, "expected 1 part for message %d", msg.ID)
	}
}

// TestAgentService_AppendMessage_PartInsertFailure_RollsBackMessage verifies that
// when part insertion fails, the entire transaction is rolled back and no partial
// agent_messages row remains committed.
func TestAgentService_AppendMessage_PartInsertFailure_RollsBackMessage(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping DB integration test in short mode")
	}
	pool := setupTestPool(t)
	queries := db.New(pool)

	// Create test user and repo
	_, repoID := setupTestUserAndRepo(t, pool)

	// Create agent session
	ctx := context.Background()
	sessionID := uuid.New().String()
	_, err := queries.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       1,
		Title:        "Rollback Test Session",
		Status:       "active",
	})
	require.NoError(t, err)

	// Get initial message count
	initialMsgs, err := queries.ListAgentMessages(ctx, db.ListAgentMessagesParams{
		SessionID:  sessionID,
		PageSize:   100,
		PageOffset: 0,
	})
	require.NoError(t, err)
	initialCount := len(initialMsgs)

	// Create a custom tx manager that will fail on part creation
	mockTxManager := &mockFailingPartTxManager{
		pool:         pool,
		failAfterMsg: true, // Fail after message is created
		queries:      queries,
	}

	service := &AgentService{
		q:               queries,
		appendTxManager: mockTxManager,
	}

	// Attempt to append a message (will fail during part creation)
	parts := []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`"test content"`)},
	}
	_, err = service.AppendMessage(ctx, sessionID, "user", parts)
	require.Error(t, err, "expected error from part creation failure")

	// Verify no message was committed (rollback occurred)
	finalMsgs, err := queries.ListAgentMessages(ctx, db.ListAgentMessagesParams{
		SessionID:  sessionID,
		PageSize:   100,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Len(t, finalMsgs, initialCount, "expected no message to remain after rollback")
}

// mockFailingPartTxManager is a test double that simulates part creation failure
type mockFailingPartTxManager struct {
	pool         *pgxpool.Pool
	queries      *db.Queries
	failAfterMsg bool
}

func (m *mockFailingPartTxManager) BeginAppendTx(ctx context.Context) (agentAppendTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &mockFailingPartTx{
		tx:           tx,
		q:            db.New(tx),
		failAfterMsg: m.failAfterMsg,
	}, nil
}

type mockFailingPartTx struct {
	tx           pgx.Tx
	q            *db.Queries
	failAfterMsg bool
	msgCreated   bool
}

func (m *mockFailingPartTx) LockAgentSessionForAppend(ctx context.Context, sessionID string) (db.LockAgentSessionForAppendRow, error) {
	return m.q.LockAgentSessionForAppend(ctx, sessionID)
}

func (m *mockFailingPartTx) CreateAgentMessageWithNextSequence(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
	msg, err := m.q.CreateAgentMessageWithNextSequence(ctx, arg)
	if err == nil {
		m.msgCreated = true
	}
	return msg, err
}

func (m *mockFailingPartTx) CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
	if m.failAfterMsg && m.msgCreated {
		return db.AgentPart{}, fmt.Errorf("simulated part creation failure")
	}
	return m.q.CreateAgentPart(ctx, arg)
}

func (m *mockFailingPartTx) Commit(ctx context.Context) error {
	return m.tx.Commit(ctx)
}

func (m *mockFailingPartTx) Rollback(ctx context.Context) error {
	return m.tx.Rollback(ctx)
}
