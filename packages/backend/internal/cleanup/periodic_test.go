package cleanup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestFailedSweepsAreCountedPerCleaner(t *testing.T) {
	boom := errors.New("permission denied for table sessions")

	auth := NewAuthCleaner(&mockCleanupStore{deleteExpiredSessionsFn: func(context.Context) error { return boom }}, time.Hour)
	workspace := NewWorkspaceCleaner(&mockWorkspaceCleanupStore{cleanupIdleWorkspacesFn: func(context.Context) error { return boom }}, time.Minute)

	for _, tc := range []struct {
		name  string
		start func(context.Context)
		stop  func()
		set   func(func(time.Duration) ticker)
	}{
		{"auth", auth.Start, auth.Stop, func(f func(time.Duration) ticker) { auth.newTicker = f }},
		{"workspace", workspace.Start, workspace.Stop, func(f func(time.Duration) ticker) { workspace.newTicker = f }},
	} {
		before := testutil.ToFloat64(SweepFailures.WithLabelValues(tc.name))
		ft := &fakeTicker{ch: make(chan time.Time, 1)}
		tc.set(func(time.Duration) ticker { return ft })
		tc.start(context.Background())
		ft.ch <- time.Now()
		waitForCondition(t, time.Second, func() bool {
			return testutil.ToFloat64(SweepFailures.WithLabelValues(tc.name)) == before+1
		})
		tc.stop()
	}
}

func TestPanickingSweepDoesNotKillTheLoop(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	store := &mockWorkspaceCleanupStore{cleanupIdleSessionsFn: func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			panic("boom")
		}
		return nil
	}}
	cleaner := NewWorkspaceCleaner(store, time.Minute)
	ft := &fakeTicker{ch: make(chan time.Time)}
	cleaner.newTicker = func(time.Duration) ticker { return ft }
	cleaner.Start(context.Background())
	ft.ch <- time.Now()
	ft.ch <- time.Now() // blocks unless the loop survived the panic
	waitForCondition(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls == 2
	})
	cleaner.Stop()
}

func TestEveryCleanerClampsNonPositiveInterval(t *testing.T) {
	for _, interval := range []time.Duration{0, -time.Minute} {
		starters := []interface {
			Start(context.Context)
			Stop()
		}{
			NewAuditCleaner(&mockAuditCleanupStore{}, interval, time.Hour),
			NewWorkspaceCleaner(&mockWorkspaceCleanupStore{}, interval),
			NewWorkflowArtifactCleaner(nil, interval, 10),
			NewWorkflowCacheCleaner(nil, interval),
			NewSandboxEgressAuditCleaner(&sandboxEgressAuditCleanupStore{retentionDays: make(chan int64, 8)}, interval, 1),
		}
		for _, c := range starters {
			c.Start(context.Background())
			c.Stop()
		}
	}
}

func TestConcurrentStopIsSafe(t *testing.T) {
	cleaner := NewSandboxEgressAuditCleaner(&sandboxEgressAuditCleanupStore{retentionDays: make(chan int64, 8)}, time.Hour, 1)
	cleaner.Start(context.Background())
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cleaner.Stop()
		}()
	}
	wg.Wait()
}
