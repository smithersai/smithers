package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExternalHandlerDrainsBeforeClosingDependencies(t *testing.T) {
	tracker := newInFlightRequestTracker()
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	handler := tracker.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	go func() {
		defer close(finished)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}()
	<-started
	tracker.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	drained := make(chan error, 1)
	go func() { drained <- tracker.WaitForDrain(ctx) }()
	select {
	case err := <-drained:
		t.Fatalf("drained before request finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("new request during shutdown answered %d", response.Code)
	}
	close(release)
	<-finished
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
}

func TestExternalHandlerTimeoutCancelsRequest(t *testing.T) {
	tracker := newInFlightRequestTracker()
	started := make(chan struct{})
	finished := make(chan struct{})
	handler := tracker.Wrap(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(finished)
	}))
	go handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	<-started
	tracker.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := tracker.WaitForDrain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected bounded drain error, got %v", err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("request context was not canceled before dependency cleanup")
	}
}
