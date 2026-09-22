package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCriticalWorkerFailureChangesReadinessAndIsReturned(t *testing.T) {
	stop := make(chan struct{})
	worker := newCriticalWorker()
	handler := withCriticalWorkerReadiness(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), worker)
	worker.Start(context.Background(), "flow dispatch", func(context.Context) error {
		<-stop
		return errors.New("claim loop failed")
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ready before worker failure: %d", response.Code)
	}
	close(stop)
	select {
	case err := <-worker.Failed():
		if !strings.Contains(err.Error(), "claim loop failed") {
			t.Fatalf("unexpected worker failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker failure was not delivered")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready after worker failure: %d", response.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := worker.Wait(ctx); err == nil || !strings.Contains(err.Error(), "claim loop failed") {
		t.Fatalf("worker wait lost failure: %v", err)
	}
}

func TestCriticalWorkerCancellationDrainsWithoutFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	worker := startCriticalWorker(ctx, "flow dispatch", func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	cancel()
	waitCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := worker.Wait(waitCtx); err != nil {
		t.Fatalf("normal cancellation failed: %v", err)
	}
	if worker.Failure() != nil {
		t.Fatalf("normal cancellation marked worker unhealthy: %v", worker.Failure())
	}
}
