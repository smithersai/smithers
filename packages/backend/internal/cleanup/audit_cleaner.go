package cleanup

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// AuditCleanupStore defines the interface for audit log cleanup operations.
type AuditCleanupStore interface {
	DeleteAuditLogsOlderThan(ctx context.Context, createdAt time.Time) error
}

// AuditCleaner periodically deletes audit log entries older than the retention period.
type AuditCleaner struct {
	store     AuditCleanupStore
	interval  time.Duration
	retention time.Duration
	ticker    ticker
	newTicker func(time.Duration) ticker
	stopCh    chan struct{}
	wg        sync.WaitGroup
	mu        sync.Mutex
	running   bool
}

// NewAuditCleaner creates a new AuditCleaner.
// interval controls how often the cleanup runs; retention controls how old entries
// must be before they are deleted (e.g. 90 days).
func NewAuditCleaner(store AuditCleanupStore, interval, retention time.Duration) *AuditCleaner {
	return &AuditCleaner{
		store:     store,
		interval:  interval,
		retention: retention,
		stopCh:    make(chan struct{}),
		newTicker: func(d time.Duration) ticker {
			return &realTicker{t: time.NewTicker(d)}
		},
	}
}

// Start begins the periodic cleanup loop.
func (c *AuditCleaner) Start(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return
	}
	c.running = true

	c.ticker = c.newTicker(c.interval)
	c.wg.Add(1)
	go c.loop(ctx)
}

// loop runs the cleanup loop until stopped.
func (c *AuditCleaner) loop(ctx context.Context) {
	defer c.wg.Done()
	defer c.ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-c.ticker.Chan():
			c.sweep(ctx)
		}
	}
}

// sweep performs a single cleanup pass.
func (c *AuditCleaner) sweep(ctx context.Context) {
	cutoff := time.Now().Add(-c.retention)
	if err := c.store.DeleteAuditLogsOlderThan(ctx, cutoff); err != nil {
		slog.Warn("audit log cleanup failed", "error", err)
	} else {
		slog.Info("audit log cleanup completed", "cutoff", cutoff)
	}
}

// Stop stops the cleaner. It blocks until the current sweep completes.
func (c *AuditCleaner) Stop() {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return
	}
	c.running = false
	close(c.stopCh)
	c.mu.Unlock()

	c.wg.Wait()
}

// Wait waits for the cleaner to finish.
func (c *AuditCleaner) Wait() {
	c.wg.Wait()
}
