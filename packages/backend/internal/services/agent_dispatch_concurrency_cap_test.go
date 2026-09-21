package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mockAgentConcurrencyCounter is a stub AgentConcurrencyCounter for cap tests.
type mockAgentConcurrencyCounter struct {
	count        int
	err          error
	calls        int
	reserveFn    func(sessionID string, maxActive int) (bool, error)
	reserveCalls int
}

func (m *mockAgentConcurrencyCounter) CountActiveAgentSessionVMs(_ context.Context) (int, error) {
	m.calls++
	return m.count, m.err
}

func (m *mockAgentConcurrencyCounter) ReserveAgentSessionVMSlot(_ context.Context, sessionID string, maxActive int) (bool, error) {
	m.reserveCalls++
	if m.reserveFn != nil {
		return m.reserveFn(sessionID, maxActive)
	}
	if m.count >= maxActive {
		return false, nil
	}
	m.count++
	return true, nil
}

func newCapDispatch(counter AgentConcurrencyCounter, max int) *agentDispatch {
	svc := &AgentService{
		concurrencyCounter: counter,
		concurrencyMax:     max,
	}
	return &agentDispatch{
		svc:   svc,
		ctx:   context.Background(),
		input: DispatchAgentRunInput{SessionID: "sess-cap"},
	}
}

// At cap -> rejected with a 429-mapped QuotaExceeded error.
func TestEnforceConcurrencyCap_AtCapRejects(t *testing.T) {
	t.Parallel()

	counter := &mockAgentConcurrencyCounter{count: 5}
	d := newCapDispatch(counter, 5)

	err := d.enforceConcurrencyCap()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	assert.Equal(t, 1, counter.calls)
}

// Over cap (e.g. after a manual bump or overshoot) -> still rejected.
func TestEnforceConcurrencyCap_OverCapRejects(t *testing.T) {
	t.Parallel()

	d := newCapDispatch(&mockAgentConcurrencyCounter{count: 9}, 5)
	err := d.enforceConcurrencyCap()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 429, apiErr.Status)
}

// Below cap -> allowed.
func TestEnforceConcurrencyCap_BelowCapAllows(t *testing.T) {
	t.Parallel()

	counter := &mockAgentConcurrencyCounter{count: 4}
	d := newCapDispatch(counter, 5)

	require.NoError(t, d.enforceConcurrencyCap())
	assert.Equal(t, 1, counter.calls)
}

// Counter error -> fail OPEN (allow the dispatch). The cap is a spend guard, not
// a security boundary; a transient DB blip must not wedge every agent run.
func TestEnforceConcurrencyCap_FailsOpenOnCounterError(t *testing.T) {
	t.Parallel()

	counter := &mockAgentConcurrencyCounter{err: errors.New("db unavailable")}
	d := newCapDispatch(counter, 5)

	require.NoError(t, d.enforceConcurrencyCap())
	assert.Equal(t, 1, counter.calls)
}

// Disabled (nil counter or max <= 0) -> no-op, and the counter is never queried.
func TestEnforceConcurrencyCap_DisabledIsNoOp(t *testing.T) {
	t.Parallel()

	// nil counter
	require.NoError(t, newCapDispatch(nil, 5).enforceConcurrencyCap())

	// max == 0
	zero := &mockAgentConcurrencyCounter{count: 100}
	dZero := newCapDispatch(zero, 0)
	require.NoError(t, dZero.enforceConcurrencyCap())
	assert.Equal(t, 0, zero.calls, "counter must not be queried when the cap is disabled")

	// max < 0 (defensive; validation rejects this, but the guard must still no-op)
	neg := &mockAgentConcurrencyCounter{count: 100}
	require.NoError(t, newCapDispatch(neg, -1).enforceConcurrencyCap())
	assert.Equal(t, 0, neg.calls)
}

// Soft-precheck semantics: the PRECHECK is a plain read, so two concurrent
// dispatches can both see the same below-cap count and both pass it. That is
// accepted for the precheck because the hard gate is reserveFleetSlot's atomic
// ReserveAgentSessionVMSlot, which runs just before CreateSandbox. Here both
// prechecks read cap-1 and both pass.
func TestEnforceConcurrencyCap_SoftCapAllowsOvershoot(t *testing.T) {
	t.Parallel()

	// A shared counter that keeps returning cap-1 (neither dispatch has committed
	// its started_at yet), modeling two pods racing at the boundary.
	counter := &mockAgentConcurrencyCounter{count: 4}
	max := 5

	require.NoError(t, newCapDispatch(counter, max).enforceConcurrencyCap())
	require.NoError(t, newCapDispatch(counter, max).enforceConcurrencyCap())
	assert.Equal(t, 2, counter.calls, "both racing dispatches read the count and both pass")
}

// Integration-level: the cap runs at the correct pipeline position — after
// ensureNoActiveRun but BEFORE any DB row (workflow run/step/task) or VM is
// created. At cap, DispatchAgentRun must reject with 429 and never create a run.
func TestDispatchAgentRun_RejectsAtConcurrencyCapBeforeCreatingRun(t *testing.T) {
	t.Parallel()

	createRunCalled := false
	dq := &mockAgentDispatchQuerier{
		createWorkflowRunFn: func(_ context.Context, _ db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			createRunCalled = true
			return db.WorkflowRun{ID: 10}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	// svc.q defaults to no active run (GetAgentSessionWorkflowRunID -> !Valid),
	// so ensureNoActiveRun passes and the cap step is reached.
	counter := &mockAgentConcurrencyCounter{count: 5}
	svc.concurrencyCounter = counter
	svc.concurrencyMax = 5

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-at-cap",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 429, apiErr.Status)
	assert.False(t, createRunCalled, "dispatch must be rejected before any workflow run is created")
	assert.Equal(t, 1, counter.calls)
}
