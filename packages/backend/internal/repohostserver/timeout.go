package repohostserver

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type mutationBarrierContextKey struct{}

const (
	mutationPending uint32 = iota
	mutationStarted
	mutationTimedOut
)

// mutationBarrier linearizes the request deadline against the first
// irreversible storage operation. Exactly one side wins: the handler starts
// mutation and timeout waits for its truthful result, or timeout fences the
// handler and can safely return an early 504.
type mutationBarrier struct {
	state atomic.Uint32
}

func (b *mutationBarrier) timeOutBeforeMutation() bool {
	for {
		switch b.state.Load() {
		case mutationStarted:
			return false
		case mutationTimedOut:
			return true
		case mutationPending:
			if b.state.CompareAndSwap(mutationPending, mutationTimedOut) {
				return true
			}
		}
	}
}

// jsonTimeout bounds request handling with a deadline. Read-only requests
// (GET/HEAD) that exceed it receive an early 504 while the handler is drained
// in the background. Mutating requests receive an early 504 only while their
// mutation barrier is still pending (including while decoding a slow body).
// Once the handler crosses that barrier, irreversible storage work (FFI
// commits, renames, deletes) may be underway and cannot be cancelled, so the
// middleware waits and reports the handler's real outcome. Mutating handlers
// call checkMutationDeadline after acquiring their locks and immediately
// before the first storage mutation.
func jsonTimeout(timeout time.Duration, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			mutating := isMutatingMethod(r.Method)
			var barrier *mutationBarrier
			if mutating {
				barrier = &mutationBarrier{}
				ctx = context.WithValue(ctx, mutationBarrierContextKey{}, barrier)
			}

			tw := newBufferedTimeoutWriter()
			resultCh := make(chan any, 1)

			go func() {
				defer func() {
					if p := recover(); p != nil {
						resultCh <- p
						return
					}
					resultCh <- nil
				}()
				next.ServeHTTP(tw, r.WithContext(ctx))
			}()

			select {
			case p := <-resultCh:
				if p != nil {
					panic(p)
				}
				tw.flushTo(w)
			case <-ctx.Done():
				method, path := r.Method, r.URL.Path
				// Prefer a result that raced the deadline and is already available.
				select {
				case p := <-resultCh:
					if p != nil {
						panic(p)
					}
					tw.flushTo(w)
					return
				default:
				}
				if mutating && !barrier.timeOutBeforeMutation() {
					// The handler may have started irreversible storage work
					// that will commit regardless of what we respond, so the
					// only honest terminal response is its real outcome.
					if logger != nil {
						logger.Warn("mutating handler exceeded deadline; waiting for its real outcome", "method", method, "path", path)
					}
					p := <-resultCh
					if p != nil {
						panic(p)
					}
					tw.flushTo(w)
					if logger != nil {
						logger.Warn("mutating handler completed after deadline", "method", method, "path", path, "status", tw.recordedStatus())
					}
					return
				}
				tw.markTimedOut()
				// Decoding happens before the mutation barrier. Closing the body
				// releases a handler stuck on a slow or incomplete request body;
				// without this, an early response would still leak that goroutine.
				if r.Body != nil {
					_ = r.Body.Close()
				}
				writeAppError(w, &appError{
					StatusCode: http.StatusGatewayTimeout,
					Message:    "request timeout",
				}, nil)
				// Drain the still-running handler so its late completion (or
				// panic) is observed and logged rather than silently dropped.
				go func() {
					p := <-resultCh
					if logger == nil {
						return
					}
					if p != nil {
						logger.Error("handler panicked after request timeout", "method", method, "path", path, "panic", p)
						return
					}
					logger.Warn("handler completed after request timeout", "method", method, "path", path)
				}()
			}
		})
	}
}

// isMutatingMethod reports whether a request may perform irreversible storage
// work. Everything except GET/HEAD in the timeout route group mutates.
func isMutatingMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

// checkMutationDeadline fails a mutating request whose deadline expired before
// any irreversible work began — typically after queueing on the repository
// lock. Handlers call it after acquiring locks and before the first storage
// mutation; past that point jsonTimeout stops issuing early 504s, so this is
// the last moment a timeout can be reported without misrepresenting storage
// state.
func checkMutationDeadline(ctx context.Context) error {
	barrier, _ := ctx.Value(mutationBarrierContextKey{}).(*mutationBarrier)
	if barrier == nil {
		if err := ctx.Err(); err != nil {
			return &appError{StatusCode: http.StatusGatewayTimeout, Message: "request timeout", Cause: err}
		}
		return nil
	}

	for {
		switch barrier.state.Load() {
		case mutationStarted:
			return nil
		case mutationTimedOut:
			return &appError{StatusCode: http.StatusGatewayTimeout, Message: "request timeout", Cause: ctx.Err()}
		case mutationPending:
			if err := ctx.Err(); err != nil {
				if barrier.state.CompareAndSwap(mutationPending, mutationTimedOut) {
					return &appError{StatusCode: http.StatusGatewayTimeout, Message: "request timeout", Cause: err}
				}
				continue
			}
			if barrier.state.CompareAndSwap(mutationPending, mutationStarted) {
				return nil
			}
		}
	}
}

type bufferedTimeoutWriter struct {
	mu          sync.Mutex
	header      http.Header
	body        bytes.Buffer
	status      int
	wroteHeader bool
	timedOut    bool
}

func newBufferedTimeoutWriter() *bufferedTimeoutWriter {
	return &bufferedTimeoutWriter{
		header: make(http.Header),
		status: http.StatusOK,
	}
}

func (w *bufferedTimeoutWriter) Header() http.Header {
	return w.header
}

func (w *bufferedTimeoutWriter) WriteHeader(statusCode int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timedOut || w.wroteHeader {
		return
	}
	w.status = statusCode
	w.wroteHeader = true
}

func (w *bufferedTimeoutWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timedOut {
		return 0, http.ErrHandlerTimeout
	}
	if !w.wroteHeader {
		w.wroteHeader = true
	}
	return w.body.Write(data)
}

func (w *bufferedTimeoutWriter) recordedStatus() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

func (w *bufferedTimeoutWriter) markTimedOut() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.timedOut = true
}

func (w *bufferedTimeoutWriter) flushTo(dst http.ResponseWriter) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timedOut {
		return
	}

	for key, values := range w.header {
		for _, value := range values {
			dst.Header().Add(key, value)
		}
	}
	dst.WriteHeader(w.status)
	_, _ = dst.Write(w.body.Bytes())
}
