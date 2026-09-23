package jobs

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWorkerCancellationRemainsClaimableUntilAcknowledged(t *testing.T) {
	for _, recovery := range []string{"abandoned", "expired"} {
		t.Run(recovery, func(t *testing.T) {
			store := newTestStore(t)
			ctx := t.Context()
			scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
			receipt, err := store.Admit(ctx, testAdmission(scope, recovery, EffectReconcile, `{"n":1}`))
			require.NoError(t, err)
			for range 2 {
				pending, err := store.RequestCancellationForWorker(ctx, scope, receipt.OperationID)
				require.NoError(t, err)
				require.False(t, pending.State.Terminal())
				require.True(t, pending.CancellationRequested)
				require.True(t, pending.NeedsReconciliation)
				require.Empty(t, pending.TerminalReceipt)
			}
			claim, err := store.Claim(ctx, "first-worker", time.Minute)
			require.NoError(t, err)
			require.True(t, claim.CancellationRequested)
			require.Empty(t, claim.ExternalReceipt)
			if recovery == "abandoned" {
				require.NoError(t, store.Abandon(ctx, claim, errors.New("projection unavailable"), 0))
			} else {
				_, err = store.pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, receipt.OperationID)
				require.NoError(t, err)
				n, err := store.RecoverExpired(ctx, 1)
				require.NoError(t, err)
				require.Equal(t, 1, n)
			}
			retry, err := store.Claim(ctx, "replacement-worker", time.Minute)
			require.NoError(t, err, "projection or cleanup still needs a worker after failure/crash")
			require.Equal(t, receipt.OperationID, retry.OperationID)
			require.True(t, retry.CancellationRequested)
			require.True(t, retry.NeedsReconciliation)
			require.Empty(t, retry.ExternalReceipt)
			require.NoError(t, store.AcknowledgeCancellation(ctx, retry, json.RawMessage(`{"projected":true}`)))
			terminal, err := store.RequestCancellationForWorker(ctx, scope, receipt.OperationID)
			require.NoError(t, err)
			require.Equal(t, StateCancelled, terminal.State)
			require.JSONEq(t, `{"projected":true}`, string(terminal.TerminalReceipt))
			_, err = store.Claim(ctx, "third-worker", time.Minute)
			require.ErrorIs(t, err, ErrNoWork)
		})
	}
}
