package jobs

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A parked operation is re-claimed on every poll. Polls that change nothing
// must not grow the journal, and Wake must make a parked operation claimable
// before its backoff expires.
func TestParkedPollsDoNotJournalAndWakeSkipsTheBackoff(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	receipt, err := store.Admit(ctx, testAdmission(scope, "parked", EffectReconcile, `{"flow":"approval"}`))
	require.NoError(t, err)

	claim, err := store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	checkpoint := json.RawMessage(`{"planId":"plan-1","status":"parked"}`)
	require.NoError(t, store.Park(ctx, claim, checkpoint, 0))
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)

	for range 5 {
		poll, err := store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
		require.NoError(t, err)
		require.True(t, poll.NeedsReconciliation)
		_, err = store.Checkpoint(ctx, poll, checkpoint)
		require.NoError(t, err)
		require.NoError(t, store.Park(ctx, poll, checkpoint, 0))
	}
	after, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, head, after, "unchanged parked polls appended journal events")

	poll, err := store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
	require.NoError(t, err)
	require.NoError(t, store.Park(ctx, poll, checkpoint, time.Hour))
	_, err = store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
	require.ErrorIs(t, err, ErrNoWork)

	require.NoError(t, store.Wake(ctx, Scope{TenantID: "tenant", PrincipalID: "someone-else"}, receipt.OperationID))
	_, err = store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
	require.ErrorIs(t, err, ErrNoWork, "another principal's wake must not reach this operation")

	require.NoError(t, store.Wake(ctx, scope, receipt.OperationID))
	woken, err := store.ClaimForOperations(ctx, "worker", 30*time.Second, nil)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, woken.OperationID)
}
