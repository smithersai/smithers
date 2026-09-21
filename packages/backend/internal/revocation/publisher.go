package revocation

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Publisher records a revocation durably and fans it out.
type Publisher interface {
	Publish(ctx context.Context, event Event) error
}

// Store is the database surface a DBPublisher needs (matched by *db.Queries).
type Store interface {
	InsertRevocationEvent(ctx context.Context, arg db.InsertRevocationEventParams) (db.RevocationEvent, error)
	NotifyRevocation(ctx context.Context, payload string) error
}

// DBPublisher inserts the event row, then NOTIFYs the channel. The insert is
// the durable part: a lost NOTIFY is recovered by every Bus's catch-up poll.
// When Local is set the event is also applied in-process immediately, so the
// pod that performed the revocation never waits on its own round trip.
type DBPublisher struct {
	store Store
	local *Bus
}

// NewDBPublisher builds a publisher over the store. local may be nil.
func NewDBPublisher(store Store, local *Bus) *DBPublisher {
	return &DBPublisher{store: store, local: local}
}

// Publish stores and announces the event. It fails only when the durable
// insert fails; a NOTIFY failure is logged because the catch-up poll covers it.
func (p *DBPublisher) Publish(ctx context.Context, event Event) error {
	if p == nil || p.store == nil {
		return nil
	}
	if event.Kind == "" {
		return fmt.Errorf("revocation: event kind is required")
	}
	row, err := p.store.InsertRevocationEvent(ctx, event.ToParams())
	if err != nil {
		return fmt.Errorf("revocation: record %s: %w", event.Kind, err)
	}
	stored := FromRow(row)
	if p.local != nil {
		p.local.apply(stored)
	}
	payload, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("revocation: encode %s: %w", event.Kind, err)
	}
	if err := p.store.NotifyRevocation(ctx, string(payload)); err != nil {
		slog.Warn("revocation notify failed; catch-up poll will deliver it", "kind", event.Kind, "id", stored.ID, "error", err)
	}
	return nil
}

// NopPublisher discards events. Tests and deployments without the fan-out use it.
type NopPublisher struct{}

// Publish implements Publisher.
func (NopPublisher) Publish(context.Context, Event) error { return nil }

// PublishBestEffort publishes and logs a failure instead of returning it, for
// call sites where the revocation itself already succeeded and must not be
// reported as failed because the announcement did not go out.
func PublishBestEffort(ctx context.Context, publisher Publisher, event Event) {
	if publisher == nil {
		return
	}
	if err := publisher.Publish(ctx, event); err != nil {
		slog.Error("revocation publish failed", "kind", event.Kind, "user_id", event.UserID, "error", err)
	}
}
