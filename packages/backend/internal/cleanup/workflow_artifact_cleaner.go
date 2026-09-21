package cleanup

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type WorkflowArtifactCleanupStore interface {
	PruneExpired(ctx context.Context, batchSize int32) (int, error)
}

type WorkflowArtifactCleaner struct {
	store     WorkflowArtifactCleanupStore
	interval  time.Duration
	batchSize int32
	ticker    ticker
	newTicker func(time.Duration) ticker
	stopCh    chan struct{}
	wg        sync.WaitGroup
	mu        sync.Mutex
	running   bool
}

func NewWorkflowArtifactCleaner(store WorkflowArtifactCleanupStore, interval time.Duration, batchSize int32) *WorkflowArtifactCleaner {
	return &WorkflowArtifactCleaner{
		store:     store,
		interval:  interval,
		batchSize: batchSize,
		stopCh:    make(chan struct{}),
		newTicker: func(d time.Duration) ticker {
			return &realTicker{t: time.NewTicker(d)}
		},
	}
}

func (c *WorkflowArtifactCleaner) Start(ctx context.Context) {
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

func (c *WorkflowArtifactCleaner) loop(ctx context.Context) {
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

func (c *WorkflowArtifactCleaner) sweep(ctx context.Context) {
	if c.store == nil {
		return
	}

	deleted, err := c.store.PruneExpired(ctx, c.batchSize)
	if err != nil {
		slog.Warn("workflow artifact cleanup failed", "error", err)
		return
	}

	slog.Info("workflow artifact cleanup completed", "deleted", deleted)
}

func (c *WorkflowArtifactCleaner) Stop() {
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

func (c *WorkflowArtifactCleaner) Wait() {
	c.wg.Wait()
}
