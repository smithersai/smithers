package cleanup

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// WorkspaceCleanupStore defines the interface for workspace cleanup operations.
type WorkspaceCleanupStore interface {
	CleanupIdleSessions(ctx context.Context) error
	CleanupStalePendingWorkspaces(ctx context.Context) error
	CleanupIdleWorkspaces(ctx context.Context) error
}

// WorkspaceCleaner periodically cleans up idle workspace sessions and workspaces.
type WorkspaceCleaner struct {
	store     WorkspaceCleanupStore
	interval  time.Duration
	ticker    ticker
	newTicker func(time.Duration) ticker
	stopCh    chan struct{}
	wg        sync.WaitGroup
	mu        sync.Mutex
	running   bool
}

// NewWorkspaceCleaner creates a new WorkspaceCleaner.
func NewWorkspaceCleaner(store WorkspaceCleanupStore, interval time.Duration) *WorkspaceCleaner {
	return &WorkspaceCleaner{
		store:    store,
		interval: interval,
		stopCh:   make(chan struct{}),
		newTicker: func(d time.Duration) ticker {
			return &realTicker{t: time.NewTicker(d)}
		},
	}
}

// Start begins the periodic cleanup loop.
func (c *WorkspaceCleaner) Start(ctx context.Context) {
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
func (c *WorkspaceCleaner) loop(ctx context.Context) {
	defer c.wg.Done()
	defer c.ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-c.ticker.Chan():
			_ = c.sweep(ctx)
		}
	}
}

// sweep performs a single cleanup pass.
func (c *WorkspaceCleaner) sweep(ctx context.Context) error {
	var errs []error

	if err := c.store.CleanupIdleSessions(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup idle sessions: %w", err))
	}
	if err := c.store.CleanupStalePendingWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup stale pending workspaces: %w", err))
	}
	if err := c.store.CleanupIdleWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup idle workspaces: %w", err))
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// Stop stops the cleaner. It blocks until the current sweep completes.
func (c *WorkspaceCleaner) Stop() {
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
func (c *WorkspaceCleaner) Wait() {
	c.wg.Wait()
}
