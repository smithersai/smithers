package cleanup

import (
	"context"
	"log/slog"
	"time"
)

type SandboxEgressAuditCleanupStore interface {
	DeleteSandboxEgressAuditOlderThan(context.Context, int64) (int64, error)
}

type SandboxEgressAuditCleaner struct {
	periodicRunner
	store         SandboxEgressAuditCleanupStore
	retentionDays int64
}

func NewSandboxEgressAuditCleaner(store SandboxEgressAuditCleanupStore, interval time.Duration, retentionDays int64) *SandboxEgressAuditCleaner {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	c := &SandboxEgressAuditCleaner{store: store, retentionDays: retentionDays}
	c.init("sandbox_egress_audit", interval, 24*time.Hour)
	return c
}

func (c *SandboxEgressAuditCleaner) Start(ctx context.Context) {
	if c == nil || c.store == nil {
		return
	}
	c.start(ctx, c.sweep)
}

func (c *SandboxEgressAuditCleaner) Stop() {
	if c == nil {
		return
	}
	c.periodicRunner.Stop()
}

func (c *SandboxEgressAuditCleaner) sweep(ctx context.Context) error {
	deleted, err := c.store.DeleteSandboxEgressAuditOlderThan(ctx, c.retentionDays)
	if err != nil {
		return err
	}
	if deleted > 0 {
		slog.Info("sandbox egress audit cleanup completed", "deleted", deleted, "retention_days", c.retentionDays)
	}
	return nil
}
