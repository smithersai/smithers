package repohostserver

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTimeout_Cov_JSONTimeoutPropagatesHandlerPanicBeforeTimeout(t *testing.T) {
	handler := jsonTimeout(time.Second, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	defer func() {
		if got := recover(); got != "boom" {
			t.Fatalf("recover() = %v, want boom", got)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/panic", nil))
}

func TestTimeout_Cov_JSONTimeoutLateCompletionWithNilLogger(t *testing.T) {
	release := make(chan struct{})
	handler := jsonTimeout(5*time.Millisecond, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusAccepted)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/slow", nil))
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504", rec.Code)
	}
	close(release)
}

func TestTimeout_Cov_BufferedTimeoutWriterTimedOutBranches(t *testing.T) {
	writer := newBufferedTimeoutWriter()
	writer.Header().Set("X-Test", "before-timeout")
	writer.markTimedOut()

	n, err := writer.Write([]byte("late"))
	if !errors.Is(err, http.ErrHandlerTimeout) {
		t.Fatalf("Write err = %v, want ErrHandlerTimeout", err)
	}
	if n != 0 {
		t.Fatalf("Write n = %d, want 0", n)
	}
	writer.WriteHeader(http.StatusCreated)

	rec := httptest.NewRecorder()
	writer.flushTo(rec)
	if rec.Code != http.StatusOK {
		t.Fatalf("timed-out flush should not write headers, got status %d", rec.Code)
	}
	if rec.Header().Get("X-Test") != "" {
		t.Fatalf("timed-out flush copied headers: %v", rec.Header())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("timed-out flush wrote body %q", rec.Body.String())
	}
}

func TestTimeout_Cov_BufferedTimeoutWriterWriteImplicitlyWritesHeader(t *testing.T) {
	writer := newBufferedTimeoutWriter()
	writer.Header().Set("X-Test", "ok")

	n, err := writer.Write([]byte("body"))
	if err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	if n != len("body") {
		t.Fatalf("Write n = %d, want %d", n, len("body"))
	}

	rec := httptest.NewRecorder()
	writer.flushTo(rec)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Header().Get("X-Test") != "ok" {
		t.Fatalf("header was not flushed: %v", rec.Header())
	}
	if rec.Body.String() != "body" {
		t.Fatalf("body = %q, want body", rec.Body.String())
	}
}
