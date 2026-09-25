package webhooks

import (
	"context"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

// linearSyncTimeout bounds one background Linear sync so a slow or hung Linear
// API cannot accumulate goroutines without limit.
const linearSyncTimeout = 2 * time.Minute

// LinearSyncSubscriber handles issue and comment events for Linear sync.
type LinearSyncSubscriber interface {
	HandleSmithersIssueEvent(ctx context.Context, repoID int64, event IssueEventPayload)
	HandleSmithersCommentEvent(ctx context.Context, repoID int64, event IssueCommentEventPayload)
}

// LinearDispatcher wraps an existing Dispatcher and additionally forwards
// issue/comment events to the Linear sync subscriber on tracked background
// goroutines. Call Shutdown before closing the resources the subscriber uses.
type LinearDispatcher struct {
	inner      Dispatcher
	linearSync LinearSyncSubscriber

	// baseCtx parents every sync so Shutdown can cancel stragglers once its
	// drain deadline passes. It is detached from request contexts so a sync
	// is not cancelled when the HTTP request finishes.
	baseCtx    context.Context
	cancelBase context.CancelFunc

	mu      sync.Mutex
	closed  bool
	running sync.WaitGroup
}

// NewLinearDispatcher returns a Dispatcher that delegates to inner and also
// fires Linear sync for issue and issue_comment events.
func NewLinearDispatcher(inner Dispatcher, linearSync LinearSyncSubscriber) *LinearDispatcher {
	baseCtx, cancelBase := context.WithCancel(context.Background())
	return &LinearDispatcher{
		inner:      inner,
		linearSync: linearSync,
		baseCtx:    baseCtx,
		cancelBase: cancelBase,
	}
}

func (d *LinearDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType EventType, payload any) error {
	// Always delegate to the inner dispatcher first.
	if err := d.inner.DispatchEvent(ctx, repoID, eventType, payload); err != nil {
		return err
	}

	switch eventType {
	case EventTypeIssues:
		if ep, ok := payload.(IssueEventPayload); ok {
			d.goSync("issues", repoID, func(syncCtx context.Context) {
				d.linearSync.HandleSmithersIssueEvent(syncCtx, repoID, ep)
			})
		} else {
			slog.Debug("linear dispatch: issues event payload type mismatch")
		}
	case EventTypeIssueComment:
		if ep, ok := payload.(IssueCommentEventPayload); ok {
			d.goSync("issue_comment", repoID, func(syncCtx context.Context) {
				d.linearSync.HandleSmithersCommentEvent(syncCtx, repoID, ep)
			})
		} else {
			slog.Debug("linear dispatch: issue_comment event payload type mismatch")
		}
	}

	return nil
}

func (d *LinearDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType EventType, payload any) error {
	return d.inner.DispatchOrgEvent(ctx, orgID, eventType, payload)
}

// goSync runs one Linear sync on a tracked goroutine with a deadline and panic
// recovery. After Shutdown it drops the sync instead of racing resource teardown.
func (d *LinearDispatcher) goSync(event string, repoID int64, fn func(context.Context)) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		slog.Warn("linear dispatch: dropping sync after shutdown", "event", event, "repo_id", repoID)
		return
	}
	d.running.Add(1)
	d.mu.Unlock()

	go func() {
		defer d.running.Done()
		defer func() {
			if r := recover(); r != nil {
				slog.Error("linear dispatch: sync panic", "event", event, "repo_id", repoID,
					"panic", r, "stack", string(debug.Stack()))
			}
		}()
		syncCtx, cancel := context.WithTimeout(d.baseCtx, linearSyncTimeout)
		defer cancel()
		fn(syncCtx)
	}()
}

// Shutdown stops accepting new Linear syncs and waits for in-flight ones. If
// ctx ends first, it cancels the remaining syncs and returns ctx.Err().
func (d *LinearDispatcher) Shutdown(ctx context.Context) error {
	d.mu.Lock()
	d.closed = true
	d.mu.Unlock()

	done := make(chan struct{})
	go func() {
		d.running.Wait()
		close(done)
	}()

	select {
	case <-done:
		d.cancelBase()
		return nil
	case <-ctx.Done():
		d.cancelBase()
		return ctx.Err()
	}
}
