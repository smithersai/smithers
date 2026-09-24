package sse

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

func TestBrokerMetricsSubscriptionsChannelsSlowClientsAndCap(t *testing.T) {
	b := NewBroker(nil)
	b.conn = brokerCovNopNotifier{}
	b.MaxStreamsPerUser = 1
	go b.dispatch()
	defer b.Stop()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(b.MetricsCollectors()...)
	sub, err := b.SubscribeMulti(context.Background(), []string{"first", "second", "first"}, 1)
	require.NoError(t, err)
	assertGauge := func(name string, want float64) {
		metrics, err := reg.Gather()
		require.NoError(t, err)
		for _, m := range metrics {
			if m.GetName() == name {
				require.Equal(t, want, m.Metric[0].GetGauge().GetValue())
				return
			}
		}
		t.Fatalf("missing %s", name)
	}
	assertGauge("smithers_sse_broker_subscriptions", 1)
	assertGauge("smithers_sse_broker_channels", 2)
	_, err = b.Subscribe(context.Background(), "first", 1)
	require.Error(t, err)
	require.Equal(t, 1.0, testutil.ToFloat64(b.rejections.WithLabelValues("per_user_cap")))
	for i := 0; i <= subscriberBufSize; i++ {
		b.dispatchNotification("first", "payload")
	}
	require.Equal(t, 1.0, testutil.ToFloat64(b.slowDisconnects))
	assertGauge("smithers_sse_broker_subscriptions", 0)
	assertGauge("smithers_sse_broker_channels", 0)
	b.Unsubscribe(sub)
	require.Equal(t, 1.0, testutil.ToFloat64(b.slowDisconnects))
}

func TestBrokerMetricsRelisten(t *testing.T) {
	b := NewBroker(nil)
	b.pendingSubs["pending"] = 1
	require.True(t, b.relisten(brokerCovNopNotifier{}))
	require.Equal(t, 1.0, testutil.ToFloat64(b.relistens))
	require.Contains(t, b.channels, "pending")
}

func TestBrokerMetricsCollectWhileMutexHeld(t *testing.T) {
	b := NewBroker(nil)
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(b.MetricsCollectors()...)
	b.mu.Lock()
	defer b.mu.Unlock()
	done := make(chan error, 1)
	go func() { _, err := reg.Gather(); done <- err }()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("collector acquired broker mutex")
	}
}

type blockedUnlistenNotifier struct {
	brokerCovNopNotifier
	entered         chan context.Context
	releaseUnlisten chan struct{}
}

func (n *blockedUnlistenNotifier) unlisten(ctx context.Context, channel string) error {
	select {
	case n.entered <- ctx:
	default:
	}
	select {
	case <-n.releaseUnlisten:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestBrokerMetricsScrapeDuringBlockedUnlisten(t *testing.T) {
	n := &blockedUnlistenNotifier{entered: make(chan context.Context, 1), releaseUnlisten: make(chan struct{})}
	b := NewBroker(nil)
	b.acquireConn = func(context.Context) (brokerNotifier, error) { return n, nil }
	require.NoError(t, b.Start(context.Background()))
	defer b.Stop()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	reg.MustRegister(b.MetricsCollectors()...)
	sub, err := b.Subscribe(context.Background(), "blocked", 1)
	require.NoError(t, err)
	// Overflow dispatch takes the mutex through UNLISTEN, unlike Unsubscribe.
	for i := 0; i < subscriberBufSize; i++ {
		b.dispatchNotification("blocked", "data")
	}
	dropped := make(chan struct{})
	go func() { b.dispatchNotification("blocked", "data"); close(dropped) }()
	queryCtx := <-n.entered
	deadline, ok := queryCtx.Deadline()
	require.True(t, ok)
	require.WithinDuration(t, time.Now().Add(brokerUnlistenTimeout), deadline, time.Second)
	scraped := make(chan string, 1)
	go func() {
		w := httptest.NewRecorder()
		promhttp.HandlerFor(reg, promhttp.HandlerOpts{}).ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
		scraped <- w.Body.String()
	}()
	select {
	case body := <-scraped:
		require.Contains(t, body, "smithers_sse_broker_subscriptions 0")
		require.Contains(t, body, "smithers_sse_broker_channels 0")
	case <-time.After(time.Second):
		t.Fatal("scrape waited for UNLISTEN")
	}
	// The production deadline must release the blocked operation.
	select {
	case <-dropped:
	case <-time.After(brokerUnlistenTimeout + time.Second):
		t.Fatal("UNLISTEN deadline did not release dispatch")
	}
	close(n.releaseUnlisten)
	b.Unsubscribe(sub)
	recovered, err := b.SubscribeMulti(context.Background(), []string{"a", "b"}, 2)
	require.NoError(t, err)
	require.Equal(t, 1, b.ActiveConnections())
	require.Equal(t, int64(2), b.channelCount.Load())
	b.Unsubscribe(recovered)
	require.Zero(t, b.ActiveConnections())
	require.Zero(t, b.channelCount.Load())
	b.Stop()
	require.Zero(t, b.ActiveConnections())
}

type blockedListenNotifier struct {
	brokerCovNopNotifier
	entered chan context.Context
}

func (n *blockedListenNotifier) listen(ctx context.Context, _ string) error {
	select {
	case n.entered <- ctx:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}

// A stalled LISTEN must not hold the dispatch goroutine, which owns all NOTIFY
// fan-out, without a deadline.
func TestBrokerListenHasDeadline(t *testing.T) {
	n := &blockedListenNotifier{entered: make(chan context.Context, 1)}
	b := NewBroker(nil)
	b.conn = n
	go b.dispatch()
	defer b.Stop()
	subscribed := make(chan error, 1)
	go func() {
		_, err := b.Subscribe(context.Background(), "stalled", 1)
		subscribed <- err
	}()
	select {
	case ctx := <-n.entered:
		deadline, ok := ctx.Deadline()
		require.True(t, ok, "LISTEN on the dispatch goroutine needs a deadline")
		require.WithinDuration(t, time.Now().Add(brokerListenTimeout), deadline, time.Second)
	case <-time.After(time.Second):
		t.Fatal("LISTEN was not issued")
	}
	select {
	case err := <-subscribed:
		require.Error(t, err)
	case <-time.After(brokerListenTimeout + time.Second):
		t.Fatal("stalled LISTEN blocked Subscribe past its deadline")
	}

	recovering := NewBroker(nil)
	recovering.pendingSubs["again"] = 1
	relistened := make(chan bool, 1)
	go func() {
		relistened <- recovering.relisten(&blockedListenNotifier{entered: make(chan context.Context, 1)})
	}()
	select {
	case ok := <-relistened:
		require.False(t, ok, "a timed-out re-LISTEN is a lost connection")
	case <-time.After(brokerListenTimeout + time.Second):
		t.Fatal("stalled re-LISTEN blocked recovery past its deadline")
	}
}
