package revocation_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Promoted from reviews/release-2026-09-13/evidence/shutdown_repro.go.txt
// (finding R010). The API's shutdown sequence relies on this contract: the
// listener holds one pooled connection for its whole life, and once its context
// is cancelled and Done() has closed that connection is back in the pool, so
// pool.Close returns instead of waiting on the LISTEN loop. The review
// reproduction showed pool.Close blocking for as long as the context stayed
// uncancelled, which is what production's context.Background() parent did.
func TestReleaseReviewPoolClosesAfterListenerStops(t *testing.T) {
	dsn := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL is unset; this test needs PostgreSQL")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	bus := revocation.NewBus(pool, nil)
	require.NoError(t, bus.Start(ctx))
	t.Cleanup(func() {
		cancel()
		closed := make(chan struct{})
		go func() {
			pool.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-time.After(5 * time.Second):
			t.Error("pool cleanup did not finish after listener cancellation")
		}
	})

	deadline := time.Now().Add(5 * time.Second)
	for pool.Stat().AcquiredConns() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	require.NotZero(t, pool.Stat().AcquiredConns(), "listener did not acquire its pooled connection")

	// Reproduce the retained connection at the real pool boundary. The API
	// must cancel and join the listener to allow this close to finish.
	closed := make(chan struct{})
	go func() {
		pool.Close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("pool closed while the listener still held its connection")
	case <-time.After(100 * time.Millisecond):
	}

	cancel()
	select {
	case <-bus.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("listener did not stop within 5s of cancellation")
	}
	require.Zero(t, pool.Stat().AcquiredConns(), "listener stopped but still holds a pooled connection")

	select {
	case <-closed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("pool.Close remains blocked after the revocation listener was cancelled and joined")
	}
}
