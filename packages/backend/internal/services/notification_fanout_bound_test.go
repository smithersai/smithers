package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestNotificationService_NotifyWatchersDropsFanoutsBeyondTheQueue(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	var started atomic.Int64
	svc := NewNotificationService(&mockNotificationQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			started.Add(1)
			<-release
			return db.Repository{}, context.Canceled
		},
	})
	queued := cap(svc.fanoutQueue)
	require.Positive(t, queued)

	for range queued + 10 {
		svc.NotifyWatchers(context.Background(), 1, "issue", 1, "s", "b")
	}
	require.Eventually(t, func() bool { return started.Load() == int64(cap(svc.fanoutSem)) }, 5*time.Second, 10*time.Millisecond)
	close(release)
	require.Eventually(t, func() bool { return started.Load() == int64(queued) }, 5*time.Second, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	require.Equal(t, int64(queued), started.Load(), "fan-outs beyond the queue are dropped, not parked")
}

func TestNotificationService_NotifyWatchersSurvivesAPanickingFanout(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 2)
	svc := NewNotificationService(&mockNotificationQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			done <- struct{}{}
			panic("fan-out bug")
		},
	})
	svc.NotifyWatchers(context.Background(), 1, "issue", 1, "s", "b")
	svc.NotifyWatchers(context.Background(), 1, "issue", 1, "s", "b")
	for range 2 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("fan-out did not run; a panic must release its queue and semaphore slots")
		}
	}
}
