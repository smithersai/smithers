package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestAgentService_DispatchAgentRun_SetsStartedAt(t *testing.T) {
	t.Parallel()

	var capturedStartedAt pgtype.Timestamptz
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionStartedAtFn: func(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
			capturedStartedAt = arg.StartedAt
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.StartedAt = arg.StartedAt
			return s, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "session-started-at",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	assert.True(t, capturedStartedAt.Valid)
	assert.WithinDuration(t, time.Now().UTC(), capturedStartedAt.Time, 5*time.Second)
}

func TestAgentService_IngestRunnerEvent_DoneSetsFinishedAtAndMetrics(t *testing.T) {
	t.Parallel()

	var capturedFinishedAt pgtype.Timestamptz
	var capturedStatusPayload string
	sessionMetrics := &mockAgentSessionMetricsObserver{}
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			capturedFinishedAt = arg.FinishedAt
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.WorkflowRunID = pgtype.Int8{Valid: false}
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
	}

	svc := &AgentService{
		q: &mockAgentQuerier{
			notifyAgentSessionFn: func(ctx context.Context, arg db.NotifyAgentSessionParams) error {
				capturedStatusPayload = arg.Payload
				return nil
			},
		},
		dispatchQ:      dq,
		sessionMetrics: sessionMetrics,
	}

	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-done-finished-at",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)
	assert.True(t, capturedFinishedAt.Valid)
	assert.Equal(t, []string{"completed"}, sessionMetrics.completions)
	assert.Equal(t, 0, sessionMetrics.timeouts)
	var payload AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(capturedStatusPayload), &payload))
	assert.Equal(t, "sess-done-finished-at", payload.SessionID)
	assert.Equal(t, "status", payload.Action)
	assert.Equal(t, "completed", payload.Status)
}

func TestAgentService_ReapExpiredSessions_TimesOutSessionAndRecordsMetrics(t *testing.T) {
	t.Parallel()

	sessionMetrics := &mockAgentSessionMetricsObserver{}
	var (
		capturedTerminalTaskStatus string
		capturedLastError          string
		capturedStatusPayload      string
		deletedVMID                string
		revokedRunID               int64
	)

	session := sampleDBAgentSession("sess-timeout", 101, 1, "default")
	session.WorkflowRunID = pgtype.Int8{Int64: 99, Valid: true}
	session.StartedAt = pgtype.Timestamptz{Time: time.Now().UTC().Add(-45 * time.Minute), Valid: true}

	dq := &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(ctx context.Context, startedBefore pgtype.Timestamptz) ([]db.AgentSession, error) {
			return []db.AgentSession{session}, nil
		},
		updateAgentSessionTimedOutFn: func(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			s := session
			s.Status = "timed_out"
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{
				ID:             77,
				WorkflowRunID:  workflowRunID,
				WorkflowStepID: 33,
				VmID:           pgtype.Text{String: "vm-timeout", Valid: true},
			}, nil
		},
		markWorkflowTaskTerminalByIDFn: func(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			capturedTerminalTaskStatus = arg.Status
			capturedLastError = arg.LastError.String
			return 1, nil
		},
		getWorkflowRunByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: workflowRunID, Status: "running", CreatedAt: time.Now().UTC().Add(-time.Minute)}, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(ctx context.Context, workflowRunID int64) (string, error) {
			return "failure", nil
		},
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			revokedRunID = arg.ID
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}

	svc := &AgentService{
		q: &mockAgentQuerier{
			notifyAgentSessionFn: func(ctx context.Context, arg db.NotifyAgentSessionParams) error {
				capturedStatusPayload = arg.Payload
				return nil
			},
		},
		dispatchQ:      dq,
		sessionMetrics: sessionMetrics,
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVMID = vmID
				return nil
			},
		},
	}

	err := svc.reapExpiredSessions(context.Background(), 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "failed", capturedTerminalTaskStatus)
	assert.Equal(t, "agent session timed out", capturedLastError)
	assert.Equal(t, "vm-timeout", deletedVMID)
	assert.Equal(t, int64(99), revokedRunID)
	assert.Equal(t, []string{"timed_out"}, sessionMetrics.completions)
	assert.Equal(t, 1, sessionMetrics.timeouts)
	var payload AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(capturedStatusPayload), &payload))
	assert.Equal(t, "sess-timeout", payload.SessionID)
	assert.Equal(t, "status", payload.Action)
	assert.Equal(t, "timed_out", payload.Status)
}

func TestAgentService_ReapExpiredSessions_ToleratesMissingSandboxVM(t *testing.T) {
	t.Parallel()

	session := sampleDBAgentSession("sess-timeout-404", 101, 1, "default")
	session.WorkflowRunID = pgtype.Int8{Int64: 88, Valid: true}
	session.StartedAt = pgtype.Timestamptz{Time: time.Now().UTC().Add(-45 * time.Minute), Valid: true}

	dq := &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(ctx context.Context, startedBefore pgtype.Timestamptz) ([]db.AgentSession, error) {
			return []db.AgentSession{session}, nil
		},
		updateAgentSessionTimedOutFn: func(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			s := session
			s.Status = "timed_out"
			s.FinishedAt = arg.FinishedAt
			return s, nil
		},
		getWorkflowTaskByRunIDFn: func(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{
				ID:             66,
				WorkflowRunID:  workflowRunID,
				WorkflowStepID: 22,
				VmID:           pgtype.Text{String: "vm-gone", Valid: true},
			}, nil
		},
	}

	svc := &AgentService{
		q:         &mockAgentQuerier{},
		dispatchQ: dq,
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				return &sandbox.StatusError{StatusCode: 404, Message: "gone"}
			},
		},
	}

	err := svc.reapExpiredSessions(context.Background(), 30*time.Minute)
	require.NoError(t, err)
}
