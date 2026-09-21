package webhooks

import (
	"context"
	"log/slog"
)

// LinearSyncSubscriber handles issue and comment events for Linear sync.
type LinearSyncSubscriber interface {
	HandleSmithersIssueEvent(ctx context.Context, repoID int64, event IssueEventPayload)
	HandleSmithersCommentEvent(ctx context.Context, repoID int64, event IssueCommentEventPayload)
}

// linearDispatcher wraps an existing Dispatcher and additionally forwards
// issue/comment events to the Linear sync subscriber.
type linearDispatcher struct {
	inner      Dispatcher
	linearSync LinearSyncSubscriber
}

// NewLinearDispatcher returns a Dispatcher that delegates to inner and also
// fires Linear sync for issue and issue_comment events.
func NewLinearDispatcher(inner Dispatcher, linearSync LinearSyncSubscriber) Dispatcher {
	return &linearDispatcher{inner: inner, linearSync: linearSync}
}

func (d *linearDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType EventType, payload any) error {
	// Always delegate to the inner dispatcher first.
	if err := d.inner.DispatchEvent(ctx, repoID, eventType, payload); err != nil {
		return err
	}

	// Fire-and-forget Linear sync for relevant event types.
	// Use context.Background() so the sync is not cancelled when the HTTP request finishes.
	switch eventType {
	case EventTypeIssues:
		if ep, ok := payload.(IssueEventPayload); ok {
			go func() {
				d.linearSync.HandleSmithersIssueEvent(context.Background(), repoID, ep)
			}()
		} else {
			slog.Debug("linear dispatch: issues event payload type mismatch")
		}
	case EventTypeIssueComment:
		if ep, ok := payload.(IssueCommentEventPayload); ok {
			go func() {
				d.linearSync.HandleSmithersCommentEvent(context.Background(), repoID, ep)
			}()
		} else {
			slog.Debug("linear dispatch: issue_comment event payload type mismatch")
		}
	}

	return nil
}

func (d *linearDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType EventType, payload any) error {
	return d.inner.DispatchOrgEvent(ctx, orgID, eventType, payload)
}
