package cleanup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type webhookDeliveryCleanupFixture struct {
	mu      sync.Mutex
	results []int64
	err     error
	calls   []db.DeleteTerminalWebhookDeliveriesOlderThanParams
}

func (f *webhookDeliveryCleanupFixture) DeleteTerminalWebhookDeliveriesOlderThan(_ context.Context, arg db.DeleteTerminalWebhookDeliveriesOlderThanParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, arg)
	if f.err != nil {
		return 0, f.err
	}
	if len(f.results) == 0 {
		return 0, nil
	}
	n := f.results[0]
	f.results = f.results[1:]
	return n, nil
}

func TestWebhookDeliveryCleanerBatchesAndReportsFailures(t *testing.T) {
	f := &webhookDeliveryCleanupFixture{results: []int64{3, 3, 1}}
	c := NewWebhookDeliveryCleaner(f, time.Hour, 30, 3)
	require.NoError(t, c.sweep(context.Background()))
	require.Len(t, f.calls, 3)
	for _, call := range f.calls {
		require.Equal(t, int64(30), call.RetentionDays)
		require.Equal(t, int32(3), call.BatchLimit)
	}
	f.err = errors.New("database unavailable")
	require.ErrorIs(t, c.sweep(context.Background()), f.err)
}

func TestWebhookDeliveryCleanerSweepsOnStart(t *testing.T) {
	f := &webhookDeliveryCleanupFixture{}
	c := NewWebhookDeliveryCleaner(f, time.Hour, 30, 1000)
	c.Start(context.Background())
	defer c.Stop()
	require.Eventually(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.calls) == 1
	}, time.Second, time.Millisecond)
}
