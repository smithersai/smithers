package sandbox

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// unreachablePool returns a lazily-connecting pool whose queries always fail
// (nothing listens on the target port). Useful to exercise DB error paths.
func unreachablePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://user:pass@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// StopTimer must not lose the interval when persisting usage fails: the
// timer is restored so a later retry (StopTimer/FlushAll) records it.
func TestMeteringService_StopTimer_RestoresTimerOnRecordFailure(t *testing.T) {
	t.Parallel()

	m := NewMeteringService(unreachablePool(t), nil, slog.Default(), nil)
	m.StartTimer("vm-1", "ws-1", 42, 0, 2, 1024)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	record, err := m.StopTimer(ctx, "vm-1")
	if err == nil {
		t.Fatal("expected recordUsage failure against unreachable DB")
	}
	if record == nil {
		t.Fatal("expected the computed usage record to be returned")
	}
	if got := m.ActiveTimerCount(); got != 1 {
		t.Fatalf("ActiveTimerCount = %d, want 1 (timer restored after failed persist)", got)
	}

	// The restored timer must preserve the original start time.
	usage := m.GetActiveUsage()
	if len(usage) != 1 || !usage[0].StartedAt.Equal(record.StartedAt) {
		t.Fatalf("restored timer lost its start time: %+v", usage)
	}
}
