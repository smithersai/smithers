package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type agentCovQuerier struct {
	*mockAgentQuerier
	listAfterFn func(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error)
}

func (q *agentCovQuerier) ListAgentMessagesAfterID(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
	if q.listAfterFn != nil {
		return q.listAfterFn(ctx, arg)
	}
	return q.mockAgentQuerier.ListAgentMessagesAfterID(ctx, arg)
}

type agentCovWorkflowMetrics struct {
	status  string
	seconds float64
}

func (m *agentCovWorkflowMetrics) ObserveWorkflowRunCompletion(status string, seconds float64) {
	m.status = status
	m.seconds = seconds
}

func TestAgent_Cov_PgxAppendTxLifecycle(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	queries := db.New(pool)
	sessionID := uuid.NewString()
	_, err := queries.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ID:           sessionID,
		RepositoryID: repoID,
		UserID:       userID,
		Title:        "pgx append tx coverage",
		Status:       "active",
	})
	require.NoError(t, err)

	manager := &pgxAgentAppendTxManager{pool: pool}
	tx, err := manager.BeginAppendTx(ctx)
	require.NoError(t, err)
	locked, err := tx.LockAgentSessionForAppend(ctx, sessionID)
	require.NoError(t, err)
	assert.Equal(t, repoID, locked.RepositoryID)

	msg, err := tx.CreateAgentMessageWithNextSequence(ctx, db.CreateAgentMessageWithNextSequenceParams{
		SessionID: sessionID,
		Role:      "user",
	})
	require.NoError(t, err)
	part, err := tx.CreateAgentPart(ctx, db.CreateAgentPartParams{
		MessageID:    msg.ID,
		RepositoryID: locked.RepositoryID,
		SessionID:    sessionID,
		PartIndex:    0,
		PartType:     "text",
		Content:      json.RawMessage(`{"value":"hello from tx"}`),
	})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	parts, err := queries.ListAgentMessageParts(ctx, msg.ID)
	require.NoError(t, err)
	require.Len(t, parts, 1)
	assert.Equal(t, part.ID, parts[0].ID)
	assert.Equal(t, repoID, parts[0].RepositoryID)

	rollbackTx, err := manager.BeginAppendTx(ctx)
	require.NoError(t, err)
	rolledBackMsg, err := rollbackTx.CreateAgentMessageWithNextSequence(ctx, db.CreateAgentMessageWithNextSequenceParams{
		SessionID: sessionID,
		Role:      "assistant",
	})
	require.NoError(t, err)
	require.NoError(t, rollbackTx.Rollback(ctx))

	var exists bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM agent_messages WHERE id = $1)`,
		rolledBackMsg.ID,
	).Scan(&exists))
	assert.False(t, exists)
}

func TestAgent_Cov_ConstructorsAndOptions(t *testing.T) {
	sandboxClient := &mockSandboxVMClient{}
	sandboxMetrics := &mockSandboxMetricsRecorder{}
	workflowMetrics := &agentCovWorkflowMetrics{}
	sessionMetrics := &mockAgentSessionMetricsObserver{}
	secretReader := &mockAgentSecretReader{}
	secretInjector := &SecretInjector{}
	cfg := AgentSandboxConfig{MemoryMB: 1024, VCPUCount: 2, RootfsSizeMB: 4096, MaxRuntime: time.Minute}

	svc := NewAgentServiceWithPool(&mockAgentQuerier{}, nil,
		WithAgentSecretInjector(secretInjector),
		WithAgentAPIBaseURL("https://api.example.test"),
		WithAgentGitBaseURL("https://git.example.test"),
		WithAgentSandboxClient(sandboxClient),
		WithAgentSandboxMetrics(sandboxMetrics),
		WithAgentWorkflowMetrics(workflowMetrics),
		WithAgentSessionMetrics(sessionMetrics),
		WithAgentSnapshotID(" snap-agent "),
		WithAgentBillingPolicy(nil),
		WithAgentSecretService(secretReader),
		WithAgentSandboxConfig(cfg),
	)

	assert.Nil(t, svc.appendTxManager)
	assert.Same(t, secretInjector, svc.secretInjector)
	assert.Equal(t, "https://api.example.test", svc.apiBaseURL)
	assert.Equal(t, "https://git.example.test", svc.gitBaseURL)
	assert.Same(t, sandboxClient, svc.sandbox)
	assert.Same(t, sandboxMetrics, svc.sandboxMetrics)
	assert.Same(t, workflowMetrics, svc.workflowMetrics)
	assert.Same(t, sessionMetrics, svc.sessionMetrics)
	assert.Equal(t, "snap-agent", svc.agentSnapshotID)
	assert.Same(t, secretReader, svc.secretService)
	assert.Equal(t, cfg, svc.sandboxConfig)

	pool := getAgentTestPool(t)
	withPool := NewAgentServiceWithPool(&mockAgentQuerier{}, pool)
	require.NotNil(t, withPool.appendTxManager)
	_, ok := withPool.appendTxManager.(*pgxAgentAppendTxManager)
	assert.True(t, ok)
}

func TestAgent_Cov_ListMessagesAfterIDBranches(t *testing.T) {
	t.Run("nil store", func(t *testing.T) {
		svc := NewAgentService(nil)
		_, err := svc.ListMessagesAfterID(context.Background(), "s", 1, 10)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "agent store")
	})

	t.Run("clamps limit and includes parts", func(t *testing.T) {
		sessionID := "session-after"
		var captured db.ListAgentMessagesAfterIDParams
		q := &agentCovQuerier{
			mockAgentQuerier: &mockAgentQuerier{
				listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
					return []db.AgentPart{
						sampleDBAgentPart(99, messageID, 0, "text", json.RawMessage(`{"value":"after"}`)),
					}, nil
				},
			},
			listAfterFn: func(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
				captured = arg
				return []db.AgentMessage{sampleDBAgentMessage(55, arg.SessionID, "assistant", 3)}, nil
			},
		}
		svc := NewAgentService(q)
		messages, err := svc.ListMessagesAfterID(context.Background(), sessionID, 44, 0)
		require.NoError(t, err)
		require.Len(t, messages, 1)
		assert.Equal(t, sessionID, captured.SessionID)
		assert.Equal(t, int64(44), captured.AfterID)
		assert.Equal(t, int32(maxAgentReplayLimit), captured.MaxResults)
		assert.Equal(t, "after", renderAgentTaskPartContent(messages[0].Parts[0].Content))
	})

	t.Run("message query error", func(t *testing.T) {
		q := &agentCovQuerier{
			mockAgentQuerier: &mockAgentQuerier{},
			listAfterFn: func(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
				return nil, fmt.Errorf("select failed")
			},
		}
		svc := NewAgentService(q)
		_, err := svc.ListMessagesAfterID(context.Background(), "s", 1, 10)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "select failed")
	})

	t.Run("parts query error", func(t *testing.T) {
		q := &agentCovQuerier{
			mockAgentQuerier: &mockAgentQuerier{
				listAgentMessagePartsFn: func(ctx context.Context, messageID int64) ([]db.AgentPart, error) {
					return nil, fmt.Errorf("parts failed")
				},
			},
			listAfterFn: func(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error) {
				return []db.AgentMessage{sampleDBAgentMessage(55, arg.SessionID, "assistant", 3)}, nil
			},
		}
		svc := NewAgentService(q)
		_, err := svc.ListMessagesAfterID(context.Background(), "s", 1, 10)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "parts failed")
	})
}

func TestAgent_Cov_EnsureSessionDispatchableBranches(t *testing.T) {
	t.Run("missing dependencies", func(t *testing.T) {
		assert.Error(t, NewAgentService(nil).EnsureSessionDispatchable(context.Background(), "s"))
		assert.Error(t, NewAgentService(&mockAgentQuerier{}).EnsureSessionDispatchable(context.Background(), "s"))
	})

	t.Run("missing session maps to not found", func(t *testing.T) {
		svc := &AgentService{
			q: &mockAgentQuerier{
				getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
					return pgtype.Int8{}, pgx.ErrNoRows
				},
			},
			dispatchQ: &mockAgentDispatchQuerier{},
		}
		err := svc.EnsureSessionDispatchable(context.Background(), "missing")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not found")
	})

	t.Run("no linked run is dispatchable", func(t *testing.T) {
		svc := &AgentService{
			q: &mockAgentQuerier{
				getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
					return pgtype.Int8{Valid: false}, nil
				},
			},
			dispatchQ: &mockAgentDispatchQuerier{},
		}
		assert.NoError(t, svc.EnsureSessionDispatchable(context.Background(), "s"))
	})

	t.Run("stale linked run is dispatchable", func(t *testing.T) {
		svc := &AgentService{
			q: &mockAgentQuerier{
				getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
					return pgtype.Int8{Int64: 42, Valid: true}, nil
				},
			},
			dispatchQ: &mockAgentDispatchQuerier{
				getWorkflowRunByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error) {
					return db.WorkflowRun{}, pgx.ErrNoRows
				},
			},
		}
		assert.NoError(t, svc.EnsureSessionDispatchable(context.Background(), "s"))
	})

	t.Run("active linked run conflicts", func(t *testing.T) {
		svc := &AgentService{
			q: &mockAgentQuerier{
				getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
					return pgtype.Int8{Int64: 42, Valid: true}, nil
				},
			},
			dispatchQ: &mockAgentDispatchQuerier{
				getWorkflowRunByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error) {
					return db.WorkflowRun{ID: workflowRunID, Status: "queued"}, nil
				},
			},
		}
		err := svc.EnsureSessionDispatchable(context.Background(), "s")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "active run")
	})

	t.Run("terminal linked run is dispatchable", func(t *testing.T) {
		svc := &AgentService{
			q: &mockAgentQuerier{
				getAgentSessionWorkflowRunIDFn: func(ctx context.Context, id string) (pgtype.Int8, error) {
					return pgtype.Int8{Int64: 42, Valid: true}, nil
				},
			},
			dispatchQ: &mockAgentDispatchQuerier{
				getWorkflowRunByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error) {
					return db.WorkflowRun{ID: workflowRunID, Status: "success"}, nil
				},
			},
		}
		assert.NoError(t, svc.EnsureSessionDispatchable(context.Background(), "s"))
	})
}

func TestAgent_Cov_IngestRenderSecretsAndDeleteBranches(t *testing.T) {
	t.Run("invalid event type", func(t *testing.T) {
		svc := NewAgentService(&mockAgentQuerier{})
		err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{SessionID: "s", EventType: "bogus"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid event type")
	})

	t.Run("done event needs dispatch querier", func(t *testing.T) {
		svc := NewAgentService(&mockAgentQuerier{})
		err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
			SessionID: "s",
			EventType: "done",
			Content:   json.RawMessage(`{"error":"boom"}`),
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "dispatch querier")
	})

	t.Run("rendering handles content variants", func(t *testing.T) {
		parts := []AgentPartResponse{
			{Content: json.RawMessage(`{"value":"from value"}`)},
			{Content: []byte(`{"output":"from output"}`)},
			{Content: map[string]any{"other": "field"}},
			{Content: "literal"},
			{Content: nil},
		}
		rendered := renderAgentTaskMessageContent(parts)
		assert.Contains(t, rendered, "from value")
		assert.Contains(t, rendered, "from output")
		assert.Contains(t, rendered, `"other":"field"`)
		assert.Contains(t, rendered, "literal")
		assert.Equal(t, "not-json", renderAgentTaskJSONContent([]byte("not-json")))

		taskStatus, stepStatus := agentTerminalWorkflowStatuses("completed")
		assert.Equal(t, "done", taskStatus)
		assert.Equal(t, "success", stepStatus)
		taskStatus, stepStatus = agentTerminalWorkflowStatuses("cancelled")
		assert.Equal(t, "cancelled", taskStatus)
		assert.Equal(t, "cancelled", stepStatus)
		taskStatus, stepStatus = agentTerminalWorkflowStatuses("failed")
		assert.Equal(t, "failed", taskStatus)
		assert.Equal(t, "failure", stepStatus)

		assert.Equal(t, "boom", agentDoneErrorMessage(json.RawMessage(`{"error":" boom "}`)))
		assert.Empty(t, agentDoneErrorMessage(json.RawMessage(`{`)))
	})

	t.Run("secret injection preserves reserved environment", func(t *testing.T) {
		env := map[string]string{"KEEP": "original"}
		svc := &AgentService{
			secretService: &mockAgentSecretReader{
				listDecryptedSecretsForRepoFn: func(ctx context.Context, repositoryID int64) (map[string]string, error) {
					assert.Equal(t, int64(77), repositoryID)
					return map[string]string{"KEEP": "secret", "NEW_SECRET": "value"}, nil
				},
			},
		}
		require.NoError(t, svc.injectAgentRepoSecrets(context.Background(), 77, env))
		assert.Equal(t, "original", env["KEEP"])
		assert.Equal(t, "value", env["NEW_SECRET"])

		var nilSvc *AgentService
		assert.NoError(t, nilSvc.injectAgentRepoSecrets(context.Background(), 77, env))
		assert.NoError(t, svc.injectAgentRepoSecrets(context.Background(), 0, env))
		assert.NoError(t, svc.injectAgentRepoSecrets(context.Background(), 77, nil))
	})

	t.Run("delete verifies ownership and delete errors", func(t *testing.T) {
		svc := NewAgentService(&mockAgentQuerier{
			getAgentSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
				return sampleDBAgentSession(id, 101, 1, "owned by someone else"), nil
			},
		})
		err := svc.DeleteSession(context.Background(), "s", 2)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "do not own")

		svc = NewAgentService(&mockAgentQuerier{
			getAgentSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
				return sampleDBAgentSession(id, 101, 1, "owned"), nil
			},
			deleteAgentSessionFn: func(ctx context.Context, arg db.DeleteAgentSessionParams) error {
				return fmt.Errorf("delete failed")
			},
		})
		err = svc.DeleteSession(context.Background(), "s", 1)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "delete failed")
	})
}

func TestAgent_Cov_RuntimeWatchdogBookkeeping(t *testing.T) {
	deleted := make(chan string, 1)
	svc := &AgentService{
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deleted <- vmID
				return nil
			},
		},
		sandboxConfig: AgentSandboxConfig{MaxRuntime: time.Hour},
		watchdogs:     map[string]*agentRuntimeWatchdog{},
	}

	svc.startAgentRuntimeWatchdog("", "vm", 1, 0)
	assert.Empty(t, svc.watchdogs)
	svc.startAgentRuntimeWatchdog("session", "", 1, 0)
	assert.Empty(t, svc.watchdogs)

	svc.startAgentRuntimeWatchdog("session", "vm-1", 1, 0)
	svc.watchdogsMu.Lock()
	first := svc.watchdogs["session"]
	svc.watchdogsMu.Unlock()
	require.NotNil(t, first)

	svc.startAgentRuntimeWatchdog("session", "vm-2", 1, 0)
	svc.watchdogsMu.Lock()
	second := svc.watchdogs["session"]
	svc.watchdogsMu.Unlock()
	require.NotNil(t, second)
	assert.NotSame(t, first, second)

	svc.clearAgentRuntimeWatchdog("session", first)
	svc.watchdogsMu.Lock()
	assert.Same(t, second, svc.watchdogs["session"])
	svc.watchdogsMu.Unlock()

	svc.cancelAgentRuntimeWatchdog("session")
	svc.watchdogsMu.Lock()
	_, ok := svc.watchdogs["session"]
	svc.watchdogsMu.Unlock()
	assert.False(t, ok)
	svc.cancelAgentRuntimeWatchdog(" ")

	fastSvc := &AgentService{
		sandbox:       svc.sandbox,
		sandboxConfig: AgentSandboxConfig{MaxRuntime: 10 * time.Millisecond},
		watchdogs:     map[string]*agentRuntimeWatchdog{},
	}
	fastSvc.startAgentRuntimeWatchdog("fast", "vm-fast", 2, 0)
	select {
	case vmID := <-deleted:
		assert.Equal(t, "vm-fast", vmID)
	case <-time.After(time.Second):
		t.Fatal("watchdog did not delete VM after max runtime")
	}
}

func TestAgent_Cov_GenerateTokenAndSerializeHistory(t *testing.T) {
	plaintext, hash, err := generateAgentToken()
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(plaintext, "smithers_agent_"))
	assert.Len(t, strings.TrimPrefix(plaintext, "smithers_agent_"), 40)
	assert.Len(t, hash, 64)

	history := serializeAgentTaskMessageHistory([]AgentMessageResponse{
		{
			Role: "user",
			Parts: []AgentPartResponse{
				{Content: json.RawMessage(`{"value":"hello"}`)},
			},
		},
	})
	require.Len(t, history, 1)
	assert.Equal(t, "user", history[0].Role)
	assert.Equal(t, "hello", history[0].Content)
	assert.Empty(t, serializeAgentTaskMessageHistory(nil))
}
