package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type neverStartedFake struct {
	*mockAgentDispatchQuerier
	rows                 []db.AgentSession
	listErr, errorUpdate error
	cutoff               time.Time
	updates              int
}

func (f *neverStartedFake) ListNeverStartedAgentSessions(_ context.Context, c time.Time) ([]db.AgentSession, error) {
	f.cutoff = c
	return f.rows, f.listErr
}
func (f *neverStartedFake) FailNeverStartedAgentSession(_ context.Context, p db.FailNeverStartedAgentSessionParams) (db.AgentSession, error) {
	f.updates++
	if f.errorUpdate != nil {
		return db.AgentSession{}, f.errorUpdate
	}
	return db.AgentSession{ID: p.ID, Status: "failed", Metadata: []byte(`{"failure_reason":"never_started"}`)}, nil
}
func TestAgentReaperNeverStarted(t *testing.T) {
	for _, timeout := range []time.Duration{0, 2 * time.Hour} {
		t.Run(timeout.String(), func(t *testing.T) {
			f := &neverStartedFake{mockAgentDispatchQuerier: &mockAgentDispatchQuerier{}, rows: []db.AgentSession{{ID: "never-started"}}}
			metrics := &mockAgentSessionMetricsObserver{}
			s := &AgentService{dispatchQ: f, sessionMetrics: metrics, neverStartedTimeout: timeout}
			require.NoError(t, s.reapExpiredSessions(context.Background(), 24*time.Hour))
			expected := timeout
			if expected == 0 {
				expected = time.Hour
			}
			require.WithinDuration(t, time.Now().Add(-expected), f.cutoff, time.Second)
			require.Equal(t, []string{"failed"}, metrics.completions)
			require.Zero(t, metrics.timeouts)
			f.errorUpdate = pgx.ErrNoRows
			require.NoError(t, s.reapNeverStartedSessions(context.Background()))
			require.Len(t, metrics.completions, 1)
			f.errorUpdate = errors.New("update failed")
			require.Error(t, s.reapNeverStartedSessions(context.Background()))
			require.Len(t, metrics.completions, 1)
			f.listErr = errors.New("list failed")
			require.Error(t, s.reapNeverStartedSessions(context.Background()))
		})
	}
}
func TestAgentCancelUsesTerminalCleanup(t *testing.T) {
	row := db.AgentSession{ID: "session", UserID: 7, Status: "active", WorkflowRunID: pgtype.Int8{Int64: 12, Valid: true}}
	deleted := false
	revoked := false
	metrics := &mockAgentSessionMetricsObserver{}
	q := &mockAgentQuerier{getAgentSessionFn: func(context.Context, string) (db.AgentSession, error) { return row, nil }}
	dq := &mockAgentDispatchQuerier{updateAgentSessionTerminalStatusFn: func(_ context.Context, p db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
		require.Equal(t, "cancelled", p.Status)
		r := row
		r.Status = p.Status
		return r, nil
	}, getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
		return db.WorkflowTask{VmID: pgtype.Text{String: "vm", Valid: true}}, nil
	}, updateWorkflowRunAgentTokenFn: func(_ context.Context, p db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
		revoked = !p.AgentTokenHash.Valid
		return db.WorkflowRun{}, nil
	}}
	s := NewAgentServiceWithPool(q, nil, WithAgentDispatchQuerier(dq), WithAgentSessionMetrics(metrics), WithAgentSandboxClient(&mockSandboxVMClient{deleteVMFn: func(context.Context, string) error { deleted = true; return nil }}))
	publisher := &recordingPublisher{}
	s.revocations = publisher
	require.NoError(t, s.CancelSession(context.Background(), row.ID, 7, "operator cancel"))
	events := publisher.all()
	require.Len(t, events, 1)
	require.EqualValues(t, 7, events[0].UserID)
	require.Equal(t, "operator cancel", events[0].Reason)
	require.True(t, deleted)
	require.True(t, revoked)
	require.Equal(t, []string{"cancelled"}, metrics.completions)
	require.Error(t, s.CancelSession(context.Background(), row.ID, 8, ""))
	dq.updateAgentSessionTerminalStatusFn = func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	require.Error(t, s.CancelSession(context.Background(), row.ID, 7, ""))
	require.Len(t, metrics.completions, 1)
	row.Status = "completed"
	require.Error(t, s.CancelSession(context.Background(), row.ID, 7, ""))
}
