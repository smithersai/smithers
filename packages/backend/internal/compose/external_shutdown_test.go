package compose

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestStart_HostDrainsBeforeProductPoolCloses(t *testing.T) {
	preserveSlog(t)
	applyEnv(t, baseRunEnv(t))
	stubSSEBroker(t)
	busCh := captureRevocationBus(t)
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	entered := make(chan error, 1)
	release := make(chan struct{})
	finished := make(chan error, 1)
	done := make(chan struct{})
	var pool *pgxpool.Pool
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	drainErr := errors.New("host drain failed")
	go func() {
		defer close(done)
		finished <- StartWithOptions(ctx, nil, io.Discard, io.Discard, Options{
			Duties: DutiesHTTP,
			BeforeShutdown: func() error {
				calls.Add(1)
				captured := <-busCh
				pool = captured.pool
				probe, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				entered <- captured.pool.Ping(probe)
				<-release
				return drainErr
			},
		}, func(http.Handler) { close(ready) })
	}()
	t.Cleanup(func() {
		cancel()
		unblock()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Error("composition leaked after cleanup")
		}
	})
	select {
	case <-ready:
	case err := <-finished:
		t.Fatalf("composition failed before ready: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("composition did not become ready")
	}
	cancel()
	select {
	case err := <-entered:
		require.NoError(t, err, "the host must retain its real product pool while draining")
	case <-time.After(10 * time.Second):
		t.Fatal("host shutdown hook was not invoked")
	}
	select {
	case err := <-finished:
		t.Fatalf("composition returned while the host still used its bindings: %v", err)
	default:
	}
	unblock()
	select {
	case err := <-finished:
		require.ErrorIs(t, err, drainErr)
	case <-time.After(10 * time.Second):
		t.Fatal("composition did not finish after host drain")
	}
	require.Equal(t, int32(1), calls.Load())
	require.Error(t, pool.Ping(context.Background()), "the product pool must close after the host has drained")
}
