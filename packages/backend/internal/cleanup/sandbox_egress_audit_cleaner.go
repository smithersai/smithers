package cleanup

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type SandboxEgressAuditCleanupStore interface {
	DeleteSandboxEgressAuditOlderThan(context.Context, int64) (int64, error)
}

type SandboxEgressAuditCleaner struct {
	store         SandboxEgressAuditCleanupStore
	interval      time.Duration
	retentionDays int64
	stopCh        chan struct{}
	wg            sync.WaitGroup
	once          sync.Once
}

func NewSandboxEgressAuditCleaner(store SandboxEgressAuditCleanupStore, interval time.Duration, retentionDays int64) *SandboxEgressAuditCleaner {
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	if retentionDays <= 0 {
		retentionDays = 30
	}
	return &SandboxEgressAuditCleaner{
		store: store, interval: interval, retentionDays: retentionDays, stopCh: make(chan struct{}),
	}
}

func (c *SandboxEgressAuditCleaner) Start(ctx context.Context) {
	if c == nil || c.store == nil {
		return
	}
	c.once.Do(func() {
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			ticker := time.NewTicker(c.interval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-c.stopCh:
					return
				case <-ticker.C:
					deleted, err := c.store.DeleteSandboxEgressAuditOlderThan(ctx, c.retentionDays)
					if err != nil {
						slog.Warn("sandbox egress audit cleanup failed", "error", err)
					} else if deleted > 0 {
						slog.Info("sandbox egress audit cleanup completed", "deleted", deleted, "retention_days", c.retentionDays)
					}
				}
			}
		}()
	})
}

func (c *SandboxEgressAuditCleaner) Stop() {
	if c == nil {
		return
	}
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}
	c.wg.Wait()
}
