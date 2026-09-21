package compose

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Release review R010: the revocation bus keeps a pooled LISTEN connection for
// its whole life. run() must cancel and join it on every exit path before the
// deferred pool.Close, otherwise pool.Close waits forever on that connection.
// Production hands run() context.Background(), so the harness cancel path used
// by the other run() tests never exercised this.

type capturedRevocationBus struct {
	bus  *revocation.Bus
	pool *pgxpool.Pool
}

// captureRevocationBus swaps the bus constructor seam so a test can observe the
// bus run() built and the pool it listens on.
func captureRevocationBus(t *testing.T) <-chan capturedRevocationBus {
	t.Helper()
	ch := make(chan capturedRevocationBus, 1)
	swapVar(t, &newRevocationBus, func(pool *pgxpool.Pool, lister revocation.Lister) *revocation.Bus {
		bus := revocation.NewBus(pool, lister)
		ch <- capturedRevocationBus{bus: bus, pool: pool}
		return bus
	})
	return ch
}

// listenerHoldsConnection reports whether the bus has positioned its cursor and
// the pool shows a connection that stays acquired: the listener keeps its
// connection for the life of the bus, whereas a metrics query releases within
// milliseconds.
func listenerHoldsConnection(c capturedRevocationBus, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c.bus.Positioned() && c.pool.Stat().AcquiredConns() > 0 {
			time.Sleep(100 * time.Millisecond)
			if c.pool.Stat().AcquiredConns() > 0 {
				return true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func requireBusStopped(t *testing.T, c capturedRevocationBus, logs *syncBuffer) {
	t.Helper()
	select {
	case <-c.bus.Done():
	case <-time.After(5 * time.Second):
		t.Fatalf("revocation bus listen loop is still running after run returned\nlogs:\n%s", logs.String())
	}
}

func TestRun_SIGTERMWithBackgroundParentReturns(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	busCh := captureRevocationBus(t)

	lnCh := make(chan net.Listener, 1)
	swapVar(t, &onListen, func(ln net.Listener) { lnCh <- ln })

	// Production parent: a context nothing ever cancels. The signal is the only
	// way out.
	logs := &syncBuffer{}
	errCh := make(chan error, 1)
	go func() { errCh <- run(context.Background(), nil, io.Discard, logs) }()

	select {
	case <-lnCh:
	case err := <-errCh:
		t.Fatalf("run returned before listening: %v\nlogs:\n%s", err, logs.String())
	case <-time.After(15 * time.Second):
		t.Fatalf("run did not start listening within 15s\nlogs:\n%s", logs.String())
	}
	var captured capturedRevocationBus
	select {
	case captured = <-busCh:
	case <-time.After(5 * time.Second):
		t.Fatal("run never constructed the revocation bus")
	}
	require.True(t, listenerHoldsConnection(captured, 10*time.Second),
		"revocation listener never acquired its pooled connection\nlogs:\n%s", logs.String())

	// Keep the test binary alive if run ever regresses signal registration.
	// Both channels receive the signal; run's is the one that drives shutdown.
	guard := make(chan os.Signal, 1)
	signal.Notify(guard, syscall.SIGTERM)
	defer signal.Stop(guard)

	require.NoError(t, syscall.Kill(os.Getpid(), syscall.SIGTERM))
	select {
	case err := <-errCh:
		require.NoError(t, err, "run should return nil after SIGTERM\nlogs:\n%s", logs.String())
		requireBusStopped(t, captured, logs)
		out := logs.String()
		assert.Contains(t, out, "shutting down")
		assert.Contains(t, out, "in-flight requests at SIGTERM")
	case <-time.After(10 * time.Second):
		t.Fatalf("run did not return within 10s of SIGTERM: pool.Close is waiting on the revocation listener\nlogs:\n%s", logs.String())
	}
}

func TestRun_StartupErrorAfterBusStartReturnsPromptly(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	busCh := captureRevocationBus(t)

	// Fail startup at the email transport step, which runs after the bus has
	// started, but only once the listener actually holds a pooled connection:
	// that is the state the deferred pool.Close must not wait on.
	listenerHeld := make(chan bool, 1)
	busCh2 := make(chan capturedRevocationBus, 1)
	swapVar(t, &newEmailTransport, func(config.EmailConfig) (email.Transport, error) {
		select {
		case captured := <-busCh:
			held := listenerHoldsConnection(captured, 10*time.Second)
			busCh2 <- captured
			listenerHeld <- held
		case <-time.After(5 * time.Second):
			listenerHeld <- false
		}
		return nil, errors.New("email boom")
	})

	logs := &syncBuffer{}
	errCh := make(chan error, 1)
	go func() { errCh <- run(context.Background(), nil, io.Discard, logs) }()

	select {
	case held := <-listenerHeld:
		require.True(t, held, "revocation listener never acquired its pooled connection before the startup error\nlogs:\n%s", logs.String())
	case <-time.After(15 * time.Second):
		t.Fatalf("startup never reached the email transport seam\nlogs:\n%s", logs.String())
	}
	captured := <-busCh2

	select {
	case err := <-errCh:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "email boom")
		assert.Contains(t, logs.String(), "failed to initialize email transport")
	case <-time.After(5 * time.Second):
		t.Fatalf("run did not return within 5s of the startup error: pool.Close is waiting on the revocation listener\nlogs:\n%s", logs.String())
	}
	requireBusStopped(t, captured, logs)
}
