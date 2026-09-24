package cleanup

import (
	"context"
	"log/slog"
	"time"
)

type WorkflowCacheCleanupStore interface {
	Cleanup(ctx context.Context) error
}

type WorkflowCacheCleaner struct {
	periodicRunner
	store WorkflowCacheCleanupStore
}

const defaultWorkflowCacheCleanupInterval = time.Hour

func NewWorkflowCacheCleaner(store WorkflowCacheCleanupStore, interval time.Duration) *WorkflowCacheCleaner {
	c := &WorkflowCacheCleaner{store: store}
	c.init("workflow_cache", interval, defaultWorkflowCacheCleanupInterval)
	return c
}

func (c *WorkflowCacheCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

func (c *WorkflowCacheCleaner) sweep(ctx context.Context) error {
	if err := c.store.Cleanup(ctx); err != nil {
		return err
	}
	slog.Info("workflow cache cleanup completed")
	return nil
}
