package compose

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime/debug"
	"sync"
)

// criticalWorker runs a durable worker whose loss makes the composition
// unavailable. A regular context cancellation is the only successful exit.
type criticalWorker struct {
	mu      sync.RWMutex
	failure error
	failed  chan error
	done    chan struct{}
}

func startCriticalWorker(ctx context.Context, name string, run func(context.Context) error) *criticalWorker {
	worker := &criticalWorker{failed: make(chan error, 1), done: make(chan struct{})}
	go func() {
		defer close(worker.done)
		defer func() {
			if value := recover(); value != nil {
				worker.fail(fmt.Errorf("%s panicked: %v\n%s", name, value, debug.Stack()))
			}
		}()
		err := run(ctx)
		if ctx.Err() != nil {
			return
		}
		if err == nil || errors.Is(err, context.Canceled) {
			err = errors.New("stopped unexpectedly")
		}
		worker.fail(fmt.Errorf("%s: %w", name, err))
	}()
	return worker
}

func (worker *criticalWorker) fail(err error) {
	worker.mu.Lock()
	if worker.failure == nil {
		worker.failure = err
		worker.failed <- err
	}
	worker.mu.Unlock()
}

func (worker *criticalWorker) Failure() error {
	if worker == nil {
		return nil
	}
	worker.mu.RLock()
	defer worker.mu.RUnlock()
	return worker.failure
}

func (worker *criticalWorker) Failed() <-chan error { return worker.failed }

func (worker *criticalWorker) Wait(ctx context.Context) error {
	select {
	case <-worker.done:
		return worker.Failure()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func withCriticalWorkerReadiness(next http.Handler, worker *criticalWorker) http.Handler {
	if worker == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" && (r.Method == http.MethodGet || r.Method == http.MethodHead) && worker.Failure() != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		next.ServeHTTP(w, r)
	})
}
