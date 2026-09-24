package cleanup

import (
	"context"
	"log/slog"
	"time"
)

type WorkflowArtifactCleanupStore interface {
	PruneExpired(ctx context.Context, batchSize int32) (int, error)
}

type WorkflowArtifactCleaner struct {
	periodicRunner
	store     WorkflowArtifactCleanupStore
	batchSize int32
}

const defaultWorkflowArtifactCleanupInterval = 24 * time.Hour

func NewWorkflowArtifactCleaner(store WorkflowArtifactCleanupStore, interval time.Duration, batchSize int32) *WorkflowArtifactCleaner {
	c := &WorkflowArtifactCleaner{store: store, batchSize: batchSize}
	c.init("workflow_artifact", interval, defaultWorkflowArtifactCleanupInterval)
	return c
}

func (c *WorkflowArtifactCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

func (c *WorkflowArtifactCleaner) sweep(ctx context.Context) error {
	if c.store == nil {
		return nil
	}

	deleted, err := c.store.PruneExpired(ctx, c.batchSize)
	if err != nil {
		return err
	}

	slog.Info("workflow artifact cleanup completed", "deleted", deleted)
	return nil
}
