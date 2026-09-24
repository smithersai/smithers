package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type agentHSecretInjectionQuerier struct{}

func (agentHSecretInjectionQuerier) GetRepoByID(context.Context, int64) (db.Repository, error) {
	return db.Repository{}, errors.New("load repo failed")
}

func (agentHSecretInjectionQuerier) ListSecretValues(context.Context, int64) ([]db.ListSecretValuesRow, error) {
	return nil, nil
}

func (agentHSecretInjectionQuerier) ListVariables(context.Context, int64) ([]db.RepositoryVariable, error) {
	return nil, nil
}

func (agentHSecretInjectionQuerier) ListOrgSecretValues(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
	return nil, nil
}

func (agentHSecretInjectionQuerier) ListOrgVariables(context.Context, int64) ([]db.OrganizationVariable, error) {
	return nil, nil
}

type agentHAppendTx struct {
	lockErr    error
	messageErr error
	partErr    error
	commitErr  error
	rolledBack bool
}

func (tx *agentHAppendTx) LockAgentSessionForAppend(context.Context, string) (db.LockAgentSessionForAppendRow, error) {
	if tx.lockErr != nil {
		return db.LockAgentSessionForAppendRow{}, tx.lockErr
	}
	return db.LockAgentSessionForAppendRow{ID: "session-h", RepositoryID: 77}, nil
}

func (tx *agentHAppendTx) CreateAgentMessageWithNextSequence(_ context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
	if tx.messageErr != nil {
		return db.AgentMessage{}, tx.messageErr
	}
	msg := sampleDBAgentMessage(41, arg.SessionID, arg.Role, 2)
	msg.RepositoryID = 77
	return msg, nil
}

func (tx *agentHAppendTx) CreateAgentPart(_ context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
	if tx.partErr != nil {
		return db.AgentPart{}, tx.partErr
	}
	part := sampleDBAgentPart(42, arg.MessageID, arg.PartIndex, arg.PartType, arg.Content)
	part.RepositoryID = arg.RepositoryID
	part.SessionID = arg.SessionID
	return part, nil
}

func (tx *agentHAppendTx) Commit(context.Context) error {
	return tx.commitErr
}

func (tx *agentHAppendTx) Rollback(context.Context) error {
	tx.rolledBack = true
	return nil
}

type agentHAppendTxManager struct {
	tx       *agentHAppendTx
	beginErr error
}

func (m agentHAppendTxManager) BeginAppendTx(context.Context) (agentAppendTx, error) {
	if m.beginErr != nil {
		return nil, m.beginErr
	}
	return m.tx, nil
}

func TestAgent_H_PublicGuardsAndPaginationFailures(t *testing.T) {
	ctx := context.Background()

	_, err := NewAgentService(&mockAgentQuerier{}).CreateSession(ctx, CreateAgentSessionInput{Title: strings.Repeat("x", 256)})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = NewAgentService(&mockAgentQuerier{}).CreateSession(ctx, CreateAgentSessionInput{Title: "bad\x00title"})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	_, err = NewAgentService(nil).GetSession(ctx, "s")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	require.Error(t, NewAgentService(nil).GetSessionForRepo(ctx, "s", 1))
	require.NoError(t, NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) {
			return sampleDBAgentSession("s", 10, 1, "ok"), nil
		},
	}).GetSessionForRepo(ctx, "s", 10))
	require.Error(t, NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) {
			return sampleDBAgentSession("s", 10, 1, "wrong repo"), nil
		},
	}).GetSessionForRepo(ctx, "s", 11))
	require.Error(t, NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) {
			return db.AgentSession{}, pgx.ErrNoRows
		},
	}).GetSessionForRepo(ctx, "missing", 10))

	_, _, err = NewAgentService(nil).ListSessions(ctx, 10, 0, 0)
	require.Error(t, err)

	_, _, err = NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(context.Context, db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			return nil, errors.New("list failed")
		},
	}).ListSessions(ctx, 10, 1, 10)
	require.Error(t, err)

	_, _, err = NewAgentService(&mockAgentQuerier{
		countAgentSessionsByRepoFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("count failed")
		},
	}).ListSessions(ctx, 10, 1, 10)
	require.Error(t, err)

	var captured db.ListAgentSessionsByRepoWithMessageCountParams
	rows, total, err := NewAgentService(&mockAgentQuerier{
		listAgentSessionsByRepoWithMessageCountFn: func(_ context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error) {
			captured = arg
			return nil, nil
		},
		countAgentSessionsByRepoFn: func(context.Context, int64) (int64, error) {
			return 0, nil
		},
	}).ListSessions(ctx, 10, -1, 999)
	require.NoError(t, err)
	assert.Empty(t, rows)
	assert.Equal(t, int64(0), total)
	assert.Equal(t, int32(0), captured.PageOffset)
	assert.Equal(t, int32(30), captured.PageSize)

	var msgPage db.ListAgentMessagesParams
	_, err = NewAgentService(&mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			msgPage = arg
			return nil, nil
		},
	}).ListMessages(ctx, "session-h", -5, 999)
	require.NoError(t, err)
	assert.Equal(t, int32(0), msgPage.PageOffset)
	assert.Equal(t, int32(50), msgPage.PageSize)
}

func TestAgent_H_AppendMessageErrorBranches(t *testing.T) {
	ctx := context.Background()

	svc := &AgentService{q: &mockAgentQuerier{}, appendTxManager: agentHAppendTxManager{beginErr: errors.New("begin failed")}}
	_, err := svc.AppendMessage(ctx, "session-h", "assistant", []db.CreateAgentPartParams{{PartType: "text"}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "begin append transaction")

	for _, tc := range []struct {
		name string
		tx   *agentHAppendTx
		want string
	}{
		{"lock", &agentHAppendTx{lockErr: errors.New("lock failed")}, "lock agent session"},
		{"message", &agentHAppendTx{messageErr: errors.New("message failed")}, "create agent message"},
		{"part", &agentHAppendTx{partErr: errors.New("part failed")}, "create agent part"},
		{"commit", &agentHAppendTx{commitErr: errors.New("commit failed")}, "commit append transaction"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &AgentService{q: &mockAgentQuerier{}, appendTxManager: agentHAppendTxManager{tx: tc.tx}}
			_, err := svc.AppendMessage(ctx, "session-h", "assistant", []db.CreateAgentPartParams{{PartType: "text", Content: json.RawMessage(`{"value":"x"}`)}})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
			assert.True(t, tc.tx.rolledBack)
		})
	}

	_, err = NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("load failed")
		},
	}).AppendMessage(ctx, "session-h", "assistant", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load agent session")

	_, err = NewAgentService(&mockAgentQuerier{
		createAgentPartFn: func(context.Context, db.CreateAgentPartParams) (db.AgentPart, error) {
			return db.AgentPart{}, errors.New("part failed")
		},
	}).AppendMessage(ctx, "session-h", "assistant", []db.CreateAgentPartParams{{PartType: "text"}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create agent part")
}

func TestAgent_H_IngestDispatchAndRenderBranches(t *testing.T) {
	ctx := context.Background()

	err := NewAgentService(nil).IngestRunnerEvent(ctx, IngestRunnerEventInput{
		SessionID: "s",
		EventType: "text",
		Content:   json.RawMessage(`{"value":"hello"}`),
	})
	require.Error(t, err)

	err = (&AgentService{
		q: &mockAgentQuerier{},
		dispatchQ: &mockAgentDispatchQuerier{
			updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
				return db.AgentSession{}, errors.New("terminal failed")
			},
		},
	}).IngestRunnerEvent(ctx, IngestRunnerEventInput{SessionID: "s", EventType: "done", Content: json.RawMessage(`{"error":"boom"}`)})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "update session status")

	err = (&AgentService{
		q: &mockAgentQuerier{},
		dispatchQ: &mockAgentDispatchQuerier{
			updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
				return db.AgentSession{}, pgx.ErrNoRows
			},
		},
	}).IngestRunnerEvent(ctx, IngestRunnerEventInput{SessionID: "s", EventType: "done", Content: json.RawMessage(`{}`)})
	require.NoError(t, err)

	err = (&AgentService{
		q: &mockAgentQuerier{
			getAgentSessionWorkflowRunIDFn: func(context.Context, string) (pgtype.Int8, error) {
				return pgtype.Int8{Int64: 30, Valid: true}, nil
			},
		},
		dispatchQ: &mockAgentDispatchQuerier{
			getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, errors.New("run load failed")
			},
		},
	}).EnsureSessionDispatchable(ctx, "s")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load workflow run")

	err = (&AgentService{
		q: &mockAgentQuerier{
			getAgentSessionWorkflowRunIDFn: func(context.Context, string) (pgtype.Int8, error) {
				return pgtype.Int8{}, errors.New("session workflow failed")
			},
		},
		dispatchQ: &mockAgentDispatchQuerier{},
	}).EnsureSessionDispatchable(ctx, "s")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load agent session workflow run")

	svc := &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("run load failed")
		},
		failWorkflowRunFn: func(context.Context, int64) error {
			return errors.New("fail run failed")
		},
	}}
	svc.markAgentDispatchInfrastructureFailed(ctx, 0, 20, 30, "", "infra failed")

	assert.Equal(t, "", agentDoneErrorMessage(nil))
	assert.Equal(t, "", renderAgentTaskMessageContent(nil))
	assert.Equal(t, "", renderAgentTaskJSONContent(nil))
	assert.Equal(t, "not json", renderAgentTaskJSONContent([]byte("not json")))
	assert.Contains(t, renderAgentTaskPartContent(make(chan int)), "0x")
	assert.True(t, sandboxSystemdInternalError(&sandbox.StatusError{StatusCode: 500, ErrorCode: " internal_error "}))
	assert.False(t, sandboxSystemdInternalError(errors.New("plain")))
}

func TestAgent_H_WatchdogTokenAndPgxBeginFailures(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (&pgxAgentAppendTxManager{pool: pool}).BeginAppendTx(ctx)
	require.Error(t, err)

	t.Run("watchdog delete failures", func(t *testing.T) {
		svc := &AgentService{
			sandbox: &mockSandboxVMClient{deleteVMFn: func(context.Context, string) error {
				return errors.New("delete failed")
			}},
			sandboxConfig: AgentSandboxConfig{MaxRuntime: time.Millisecond},
			watchdogs:     map[string]*agentRuntimeWatchdog{},
		}
		svc.startAgentRuntimeWatchdog("s-delete", "vm-delete", 1, 0)
		time.Sleep(25 * time.Millisecond)
		svc.clearAgentRuntimeWatchdog("", nil)
	})

	t.Run("random token error", func(t *testing.T) {
		old := agentRandRead
		agentRandRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
		t.Cleanup(func() { agentRandRead = old })
		plain, hash, err := generateAgentToken()
		require.Error(t, err)
		assert.Empty(t, plain)
		assert.Empty(t, hash)
	})

	t.Run("watchdog not found branch", func(t *testing.T) {
		done := make(chan struct{})
		svc := &AgentService{
			sandbox: &mockSandboxVMClient{deleteVMFn: func(context.Context, string) error {
				close(done)
				return &sandbox.StatusError{StatusCode: 404, ErrorCode: "not_found"}
			}},
			sandboxConfig: AgentSandboxConfig{MaxRuntime: time.Millisecond},
			watchdogs:     map[string]*agentRuntimeWatchdog{},
		}
		svc.startAgentRuntimeWatchdog("s-missing", "vm-missing", 1, 0)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("watchdog did not run")
		}
	})
}

func TestAgent_H_SecretInjectionError(t *testing.T) {
	svc := &AgentService{secretInjector: NewSecretInjector(agentHSecretInjectionQuerier{}, nil)}
	err := svc.injectAgentRepoSecrets(context.Background(), 123, map[string]string{"X": "Y"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository")

	want := errors.New("secret read failed")
	svc = &AgentService{secretService: &mockAgentSecretReader{
		listDecryptedSecretsForRepoFn: func(context.Context, int64) (map[string]string, error) {
			return nil, want
		},
	}}
	err = svc.injectAgentRepoSecrets(context.Background(), 123, map[string]string{})
	require.ErrorIs(t, err, want)
}

func TestAgent_H_RenderMarshalFallbackStable(t *testing.T) {
	type badJSON struct{}
	assert.Contains(t, fmt.Sprint(badJSON{}), renderAgentTaskPartContent(badJSON{}))
}
