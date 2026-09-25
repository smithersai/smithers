package webhooks

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// linearLifecycleSubscriber lets a test hold a Linear sync open, observe the
// context it received, and force a panic.
type linearLifecycleSubscriber struct {
	started chan context.Context
	release chan struct{}
	panics  bool
	calls   atomic.Int32
}

func newLinearLifecycleSubscriber() *linearLifecycleSubscriber {
	return &linearLifecycleSubscriber{
		started: make(chan context.Context, 4),
		release: make(chan struct{}),
	}
}

func (s *linearLifecycleSubscriber) handle(ctx context.Context) {
	s.calls.Add(1)
	s.started <- ctx
	if s.panics {
		panic("linear subscriber exploded")
	}
	select {
	case <-s.release:
	case <-ctx.Done():
	}
}

func (s *linearLifecycleSubscriber) HandleSmithersIssueEvent(ctx context.Context, _ int64, _ IssueEventPayload) {
	s.handle(ctx)
}

func (s *linearLifecycleSubscriber) HandleSmithersCommentEvent(ctx context.Context, _ int64, _ IssueCommentEventPayload) {
	s.handle(ctx)
}

func waitLinearStarted(t *testing.T, sub *linearLifecycleSubscriber) context.Context {
	t.Helper()
	select {
	case ctx := <-sub.started:
		return ctx
	case <-time.After(2 * time.Second):
		t.Fatal("expected Linear sync to start")
		return nil
	}
}

func TestLinearDispatch_SyncContextHasDeadline(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	d := NewLinearDispatcher(&linearCoverInner{}, sub)
	t.Cleanup(func() { close(sub.release); _ = d.Shutdown(context.Background()) })

	require.NoError(t, d.DispatchEvent(context.Background(), 1, EventTypeIssues, IssueEventPayload{Action: "opened"}))
	ctx := waitLinearStarted(t, sub)

	deadline, ok := ctx.Deadline()
	require.True(t, ok, "Linear sync must run under a deadline so a slow Linear API cannot pin goroutines forever")
	assert.WithinDuration(t, time.Now().Add(linearSyncTimeout), deadline, 5*time.Second)
}

func TestLinearDispatch_SyncOutlivesRequestContext(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	d := NewLinearDispatcher(&linearCoverInner{}, sub)
	t.Cleanup(func() { close(sub.release); _ = d.Shutdown(context.Background()) })

	reqCtx, cancelReq := context.WithCancel(context.Background())
	require.NoError(t, d.DispatchEvent(reqCtx, 1, EventTypeIssueComment, IssueCommentEventPayload{Action: "created"}))
	ctx := waitLinearStarted(t, sub)
	cancelReq()

	assert.NoError(t, ctx.Err(), "finishing the HTTP request must not cancel the Linear sync")
}

func TestLinearDispatch_SubscriberPanicIsRecovered(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	sub.panics = true
	d := NewLinearDispatcher(&linearCoverInner{}, sub)

	require.NoError(t, d.DispatchEvent(context.Background(), 1, EventTypeIssues, IssueEventPayload{Action: "opened"}))
	waitLinearStarted(t, sub)

	// An unrecovered panic would have killed the test binary. Shutdown also
	// proves the panicking goroutine released its WaitGroup slot.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, d.Shutdown(ctx))
}

func TestLinearDispatch_ShutdownWaitsForInFlightSync(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	d := NewLinearDispatcher(&linearCoverInner{}, sub)

	require.NoError(t, d.DispatchEvent(context.Background(), 1, EventTypeIssues, IssueEventPayload{Action: "opened"}))
	waitLinearStarted(t, sub)

	done := make(chan error, 1)
	go func() { done <- d.Shutdown(context.Background()) }()

	select {
	case err := <-done:
		t.Fatalf("Shutdown returned before the in-flight Linear sync finished: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	close(sub.release)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not return after the Linear sync finished")
	}
}

func TestLinearDispatch_ShutdownDeadlineCancelsInFlightSync(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	d := NewLinearDispatcher(&linearCoverInner{}, sub)

	require.NoError(t, d.DispatchEvent(context.Background(), 1, EventTypeIssues, IssueEventPayload{Action: "opened"}))
	syncCtx := waitLinearStarted(t, sub)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := d.Shutdown(shutdownCtx)
	require.ErrorIs(t, err, context.DeadlineExceeded)

	select {
	case <-syncCtx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown past its deadline must cancel the in-flight Linear sync")
	}
}

func TestLinearDispatch_NoSyncAfterShutdown(t *testing.T) {
	t.Parallel()

	sub := newLinearLifecycleSubscriber()
	inner := &linearCoverInner{}
	d := NewLinearDispatcher(inner, sub)
	require.NoError(t, d.Shutdown(context.Background()))

	require.NoError(t, d.DispatchEvent(context.Background(), 1, EventTypeIssues, IssueEventPayload{Action: "opened"}))
	assert.Equal(t, 1, inner.dispatchCalls, "webhook delivery still runs after Linear shutdown")
	assert.Equal(t, int32(0), sub.calls.Load(), "no Linear sync may start after Shutdown")
}
