package repohostserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// A mutating request whose handler outlives the deadline must receive the
// handler's real outcome, never an early 504: the storage mutation commits
// regardless, and a 504 would let the API tier roll back DB state that
// storage kept.
func TestJSONTimeout_MutatingLateCompletionReturnsRealOutcome(t *testing.T) {
	t.Parallel()

	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))

	release := make(chan struct{})
	handler := jsonTimeout(10*time.Millisecond, logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := checkMutationDeadline(r.Context()); err != nil {
			t.Errorf("start mutation: %v", err)
			return
		}
		<-release
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/repos/init", nil))
		done <- rec
	}()

	// Only release the handler once the middleware has provably taken the
	// past-deadline wait branch.
	waitForLog(t, logs, "mutating handler exceeded deadline")
	close(release)

	rec := <-done
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (the handler's real outcome)", rec.Code)
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("body = %q, want handler body", rec.Body.String())
	}
	waitForLog(t, logs, "mutating handler completed after deadline")
}

// A mutating handler that fails after the deadline must surface its real
// error status, not a fabricated 504.
func TestJSONTimeout_MutatingLateFailureReturnsRealError(t *testing.T) {
	t.Parallel()

	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))

	release := make(chan struct{})
	handler := jsonTimeout(10*time.Millisecond, logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := checkMutationDeadline(r.Context()); err != nil {
			t.Errorf("start mutation: %v", err)
			return
		}
		<-release
		w.WriteHeader(http.StatusConflict)
	}))

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/repos/alice/widget", nil))
		done <- rec
	}()

	waitForLog(t, logs, "mutating handler exceeded deadline")
	close(release)

	rec := <-done
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (the handler's real outcome)", rec.Code)
	}
}

func TestJSONTimeout_MutatingLatePanicPropagates(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	handler := jsonTimeout(10*time.Millisecond, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := checkMutationDeadline(r.Context()); err != nil {
			panic(err)
		}
		<-release
		panic("late boom")
	}))

	time.AfterFunc(50*time.Millisecond, func() { close(release) })
	defer func() {
		if got := recover(); got != "late boom" {
			t.Fatalf("recover() = %v, want late boom", got)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/repos/init", nil))
}

type closeReleasedRequestBody struct {
	readStarted chan struct{}
	closed      chan struct{}
	readOnce    atomic.Bool
	closeOnce   atomic.Bool
}

func newCloseReleasedRequestBody() *closeReleasedRequestBody {
	return &closeReleasedRequestBody{readStarted: make(chan struct{}), closed: make(chan struct{})}
}

func (b *closeReleasedRequestBody) Read([]byte) (int, error) {
	if b.readOnce.CompareAndSwap(false, true) {
		close(b.readStarted)
	}
	<-b.closed
	return 0, http.ErrBodyReadAfterClose
}

func (b *closeReleasedRequestBody) Close() error {
	if b.closeOnce.CompareAndSwap(false, true) {
		close(b.closed)
	}
	return nil
}

func TestJSONTimeout_MutatingSlowBodyReturnsBeforeMutationBarrier(t *testing.T) {
	body := newCloseReleasedRequestBody()
	handler := jsonTimeout(10*time.Millisecond, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusCreated)
	}))
	req := httptest.NewRequest(http.MethodPost, "/repos/init", nil)
	req.Body = body

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		done <- rec
	}()
	select {
	case <-body.readStarted:
	case <-time.After(time.Second):
		t.Fatal("handler did not begin reading the request body")
	}

	select {
	case rec := <-done:
		if rec.Code != http.StatusGatewayTimeout {
			t.Fatalf("status = %d, want 504", rec.Code)
		}
		if !body.closeOnce.Load() {
			t.Fatal("timed-out request body was not closed")
		}
	case <-time.After(time.Second):
		t.Fatal("pre-mutation timeout waited indefinitely for request body decoding")
	}
}

func TestIsMutatingMethod(t *testing.T) {
	t.Parallel()

	for method, want := range map[string]bool{
		http.MethodGet:    false,
		http.MethodHead:   false,
		http.MethodPost:   true,
		http.MethodPut:    true,
		http.MethodPatch:  true,
		http.MethodDelete: true,
	} {
		if got := isMutatingMethod(method); got != want {
			t.Errorf("isMutatingMethod(%s) = %v, want %v", method, got, want)
		}
	}
}

// A mutating request whose deadline is exhausted before any irreversible work
// begins (e.g. queued on the repository lock) must return 504 WITHOUT invoking
// the storage mutation — the 504 is only truthful while nothing has mutated.
func TestRouter_MutationDeadlineExpiredBeforeWorkReturns504WithoutMutating(t *testing.T) {
	t.Parallel()

	var ffiCalled atomic.Bool
	mock := &mockFFI{initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
		ffiCalled.Store(true)
		return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
	}}
	handler := newTestServerWithMock(t, mock).Handler()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the request's deadline budget is already gone

	req := httptest.NewRequest(http.MethodPost, "/repos/init", strings.NewReader(`{"owner":"alice","repo":"widget"}`)).WithContext(ctx)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504", rec.Code)
	}
	if ffiCalled.Load() {
		t.Fatal("FFI mutation ran despite the deadline having expired before it started")
	}
}

// End-to-end through the router: when the deadline expires while the FFI
// mutation is in flight, the response must be the mutation's real result — a
// 504 here is the exact defect that made the API roll back DB state after the
// storage mutation committed.
func TestRouter_MutationCompletingAfterDeadlineReturnsRealResult(t *testing.T) {
	t.Parallel()

	entered := make(chan struct{})
	release := make(chan struct{})
	mock := &mockFFI{initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
		close(entered)
		<-release
		return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
	}}
	handler := newTestServerWithMock(t, mock).Handler()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/repos/init", strings.NewReader(`{"owner":"alice","repo":"widget"}`)).WithContext(ctx)
	req.Header.Set("Authorization", validAuth())

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		done <- rec
	}()

	<-entered
	cancel() // deadline expires while the irreversible mutation is running
	// Give the middleware time to observe the expiry so the past-deadline
	// branch is exercised; the asserted invariant holds either way.
	time.Sleep(50 * time.Millisecond)
	close(release)

	rec := <-done
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: a 504 for a mutation that committed lets the API roll back DB state that storage kept", rec.Code)
	}
	var resp struct {
		Owner string `json:"owner"`
		Repo  string `json:"repo"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v (body %q)", err, rec.Body.String())
	}
	if resp.Owner != "alice" || resp.Repo != "widget" {
		t.Fatalf("response = %+v, want alice/widget", resp)
	}
}
