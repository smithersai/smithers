package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Deleting an active session whose turn runs on the canonical Flow must cancel
// that Flow request. Tombstoning the row alone leaves the durable job editing
// the workspace and spending model budget for a session nobody can see.
func TestAgentService_DeleteSession_CancelsCanonicalFlowRun(t *testing.T) {
	t.Parallel()

	const runID = int64(88)
	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			s := sampleDBAgentSession(id, 101, 7, "active session")
			s.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
			return s, nil
		},
		deleteAgentSessionFn: func(context.Context, db.DeleteAgentSessionParams) error { return nil },
	})
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(_ context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 101, 7, "active session")
			s.Status = arg.Status
			s.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
			return s, nil
		},
	}
	dispatcher := &recordingAgentFlowDispatcher{}
	svc.flowDispatcher = dispatcher

	require.NoError(t, svc.DeleteSession(context.Background(), "sess-live", 7))
	require.Len(t, dispatcher.cancels, 1)
	assert.Equal(t, agentFlowScope(101, 7), dispatcher.cancels[0].scope)
	assert.Equal(t, agentFlowRequestID(runID), dispatcher.cancels[0].requestID)
}

func TestAgentService_DeleteSession_TerminalSessionDoesNotCancelFlow(t *testing.T) {
	t.Parallel()

	svc := NewAgentService(&mockAgentQuerier{
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			s := sampleDBAgentSession(id, 101, 7, "done session")
			s.Status = "completed"
			s.WorkflowRunID = pgtype.Int8{Int64: 88, Valid: true}
			return s, nil
		},
		deleteAgentSessionFn: func(context.Context, db.DeleteAgentSessionParams) error { return nil },
	})
	dispatcher := &recordingAgentFlowDispatcher{}
	svc.flowDispatcher = dispatcher

	require.NoError(t, svc.DeleteSession(context.Background(), "sess-done", 7))
	assert.Empty(t, dispatcher.cancels)
}

// A session the reaper times out must stop its Flow run too.
func TestAgentService_ReapExpiredSession_CancelsCanonicalFlowRun(t *testing.T) {
	t.Parallel()

	const runID = int64(91)
	session := sampleDBAgentSession("sess-stale", 101, 7, "stale")
	session.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
	svc := NewAgentService(&mockAgentQuerier{})
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			timedOut := session
			timedOut.Status = "timed_out"
			return timedOut, nil
		},
	}
	dispatcher := &recordingAgentFlowDispatcher{}
	svc.flowDispatcher = dispatcher

	require.NoError(t, svc.reapExpiredSession(context.Background(), session))
	require.Len(t, dispatcher.cancels, 1)
	assert.Equal(t, agentFlowRequestID(runID), dispatcher.cancels[0].requestID)
}
