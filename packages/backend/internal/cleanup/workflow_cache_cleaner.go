package cleanup

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type WorkflowCacheCleanupStore interface {
	Cleanup(ctx context.Context) error
}

type WorkflowCacheCleaner struct {
	store     WorkflowCacheCleanupStore
	interval  time.Duration
	ticker    ticker
	newTicker func(time.Duration) ticker
	stopCh    chan struct{}
	wg        sync.WaitGroup
	mu        sync.Mutex
	running   bool
}

// defaultWorkflowCacheCleanupInterval is used when a non-positive interval is
// supplied, so a misconfigured duration cannot crash boot via time.NewTicker(d<=0).
const defaultWorkflowCacheCleanupInterval = time.Hour

func NewWorkflowCacheCleaner(store WorkflowCacheCleanupStore, interval time.Duration) *WorkflowCacheCleaner {
	if interval <= 0 {
		interval = defaultWorkflowCacheCleanupInterval
	}
	return &WorkflowCacheCleaner{
		store:    store,
		interval: interval,
		stopCh:   make(chan struct{}),
		newTicker: func(d time.Duration) ticker {
			return &realTicker{t: time.NewTicker(d)}
		},
	}
}

func (c *WorkflowCacheCleaner) Start(ctx context.Context) {
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

func (c *WorkflowCacheCleaner) loop(ctx context.Context) {
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

func (c *WorkflowCacheCleaner) sweep(ctx context.Context) {
	if err := c.store.Cleanup(ctx); err != nil {
		slog.Warn("workflow cache cleanup failed", "error", err)
		return
	}
	slog.Info("workflow cache cleanup completed")
}

func (c *WorkflowCacheCleaner) Stop() {
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

func (c *WorkflowCacheCleaner) Wait() {
	c.wg.Wait()
}
