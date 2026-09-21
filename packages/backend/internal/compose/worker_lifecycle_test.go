package compose

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestJoinedBackgroundWorkerWaitsForCancellationCleanup(t *testing.T) {
	workerCtx, workerCancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	releaseCleanup := make(chan struct{})
	worker := startJoinedBackgroundWorker(func() {
		close(started)
		<-workerCtx.Done()
		<-releaseCleanup
	})
	<-started

	workerCancel()
	waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Second)
	defer waitCancel()
	waitResult := make(chan error, 1)
	go func() { waitResult <- worker.Wait(waitCtx) }()

	select {
	case err := <-waitResult:
		t.Fatalf("Wait returned before cancellation cleanup finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(releaseCleanup)
	require.NoError(t, <-waitResult)
}

func TestJoinedBackgroundWorkerWaitHonorsShutdownDeadline(t *testing.T) {
	release := make(chan struct{})
	worker := startJoinedBackgroundWorker(func() { <-release })

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer waitCancel()
	require.ErrorIs(t, worker.Wait(waitCtx), context.DeadlineExceeded)

	close(release)
	require.NoError(t, worker.Wait(context.Background()))
}
