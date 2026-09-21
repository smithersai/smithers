package cleanup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockWorkspaceCleanupStore struct {
	calls []string

	cleanupIdleSessionsFn   func(context.Context) error
	cleanupStalePendingFn   func(context.Context) error
	cleanupIdleWorkspacesFn func(context.Context) error
}

func (m *mockWorkspaceCleanupStore) CleanupIdleSessions(ctx context.Context) error {
	m.calls = append(m.calls, "idle_sessions")
	if m.cleanupIdleSessionsFn != nil {
		return m.cleanupIdleSessionsFn(ctx)
	}
	return nil
}

func (m *mockWorkspaceCleanupStore) CleanupStalePendingWorkspaces(ctx context.Context) error {
	m.calls = append(m.calls, "stale_pending")
	if m.cleanupStalePendingFn != nil {
		return m.cleanupStalePendingFn(ctx)
	}
	return nil
}

func (m *mockWorkspaceCleanupStore) CleanupIdleWorkspaces(ctx context.Context) error {
	m.calls = append(m.calls, "idle_workspaces")
	if m.cleanupIdleWorkspacesFn != nil {
		return m.cleanupIdleWorkspacesFn(ctx)
	}
	return nil
}

func TestWorkspaceCleanerSweep_CallsAllCleanupPasses(t *testing.T) {
	t.Parallel()

	store := &mockWorkspaceCleanupStore{}
	cleaner := NewWorkspaceCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.NoError(t, err)
	assert.Equal(t, []string{"idle_sessions", "stale_pending", "idle_workspaces"}, store.calls)
}

func TestWorkspaceCleanerSweep_JoinsErrors(t *testing.T) {
	t.Parallel()

	store := &mockWorkspaceCleanupStore{
		cleanupStalePendingFn:   func(context.Context) error { return errors.New("pending failed") },
		cleanupIdleWorkspacesFn: func(context.Context) error { return errors.New("idle failed") },
	}
	cleaner := NewWorkspaceCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cleanup stale pending workspaces")
	assert.Contains(t, err.Error(), "cleanup idle workspaces")
	assert.Equal(t, []string{"idle_sessions", "stale_pending", "idle_workspaces"}, store.calls)
}
