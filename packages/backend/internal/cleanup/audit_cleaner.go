package cleanup

import (
	"context"
	"log/slog"
	"time"
)

// AuditCleanupStore defines the interface for audit log cleanup operations.
type AuditCleanupStore interface {
	DeleteAuditLogsOlderThan(ctx context.Context, createdAt time.Time) error
}

// AuditCleaner periodically deletes audit log entries older than the retention period.
type AuditCleaner struct {
	periodicRunner
	store     AuditCleanupStore
	retention time.Duration
}

const defaultAuditCleanupInterval = 24 * time.Hour

// NewAuditCleaner creates a new AuditCleaner.
// interval controls how often the cleanup runs; retention controls how old entries
// must be before they are deleted (e.g. 90 days).
func NewAuditCleaner(store AuditCleanupStore, interval, retention time.Duration) *AuditCleaner {
	c := &AuditCleaner{store: store, retention: retention}
	c.init("audit", interval, defaultAuditCleanupInterval)
	return c
}

// Start begins the periodic cleanup loop.
func (c *AuditCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

// sweep performs a single cleanup pass.
func (c *AuditCleaner) sweep(ctx context.Context) error {
	cutoff := time.Now().Add(-c.retention)
	if err := c.store.DeleteAuditLogsOlderThan(ctx, cutoff); err != nil {
		return err
	}
	slog.Info("audit log cleanup completed", "cutoff", cutoff)
	return nil
}
