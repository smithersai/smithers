package sse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var handlerCovChannelSeq uint64

type handlerCovRecorder struct {
	mu      sync.Mutex
	header  http.Header
	body    bytes.Buffer
	code    int
	flushes int
}

func handlerCovNewRecorder() *handlerCovRecorder {
	return &handlerCovRecorder{header: make(http.Header)}
}

func (r *handlerCovRecorder) Header() http.Header {
	return r.header
}

func (r *handlerCovRecorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.code == 0 {
		r.code = http.StatusOK
	}
	return r.body.Write(p)
}

func (r *handlerCovRecorder) WriteHeader(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.code == 0 {
		r.code = code
	}
}

func (r *handlerCovRecorder) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flushes++
	if r.code == 0 {
		r.code = http.StatusOK
	}
}

func (r *handlerCovRecorder) handlerCovCode() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.code
}

func (r *handlerCovRecorder) handlerCovBody() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

type handlerCovPlainWriter struct {
	header http.Header
	body   bytes.Buffer
	code   int
}

func handlerCovNewPlainWriter() *handlerCovPlainWriter {
	return &handlerCovPlainWriter{header: make(http.Header)}
}

func (w *handlerCovPlainWriter) Header() http.Header {
	return w.header
}

func (w *handlerCovPlainWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.body.Write(p)
}

func (w *handlerCovPlainWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
}

func handlerCovChannel(prefix string) string {
	n := atomic.AddUint64(&handlerCovChannelSeq, 1)
	return prefix + "_cov_" + strconv.FormatInt(time.Now().UnixNano(), 36) + "_" + strconv.FormatUint(n, 36)
}

func handlerCovNotify(t *testing.T, pool *pgxpool.Pool, channel, payload string) {
	t.Helper()
	covNotify(t, pool, channel, payload)
}

// handlerCovPoolWithApplicationName is a single-connection pool whose
// backend the test can find in pg_stat_activity by applicationName and
// terminate, on the prepared test database.
func handlerCovPoolWithApplicationName(t *testing.T, applicationName string) *pgxpool.Pool {
	t.Helper()
	covPrepareDatabase(t)
	cfg := covPoolConfig(t)
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = make(map[string]string)
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = applicationName
	cfg.MaxConns = 1
	return covOpenPool(t, cfg)
}

func handlerCovFindBackendPID(t *testing.T, pool *pgxpool.Pool, applicationName string) int {
	t.Helper()

	var pid int
	require.Eventually(t, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err := pool.QueryRow(ctx, `
			select pid
			from pg_stat_activity
			where datname = current_database()
			  and application_name = $1
			  and pid <> pg_backend_pid()
			order by backend_start desc
			limit 1
		`, applicationName).Scan(&pid)
		return err == nil && pid > 0
	}, 2*time.Second, 10*time.Millisecond)
	return pid
}

func handlerCovTerminateBackend(t *testing.T, pool *pgxpool.Pool, pid int) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var terminated bool
	require.NoError(t, pool.QueryRow(ctx, "select pg_terminate_backend($1)", pid).Scan(&terminated))
	require.True(t, terminated)
}

func handlerCovWaitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return")
	}
}

func handlerCovWaitBodyContains(t *testing.T, rec *handlerCovRecorder, substr string) {
	t.Helper()
	require.Eventually(t, func() bool {
		return strings.Contains(rec.handlerCovBody(), substr)
	}, 2*time.Second, 10*time.Millisecond)
}

func TestHandler_Cov_ServeSSEWritesConfigurationErrors(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/events", nil)

	plain := handlerCovNewPlainWriter()
	ServeSSE(plain, req, StreamConfig{})
	assert.Equal(t, http.StatusInternalServerError, plain.code)
	assert.Equal(t, "application/json", plain.header.Get("Content-Type"))
	assert.Contains(t, plain.body.String(), "streaming not supported")

	nilPool := handlerCovNewRecorder()
	ServeSSE(nilPool, req, StreamConfig{})
	assert.Equal(t, http.StatusInternalServerError, nilPool.handlerCovCode())
	assert.Contains(t, nilPool.handlerCovBody(), "pool is nil")

	pool := brokerCovPool(t)

	noChannels := handlerCovNewRecorder()
	ServeSSE(noChannels, req, StreamConfig{Pool: pool})
	assert.Equal(t, http.StatusInternalServerError, noChannels.handlerCovCode())
	assert.Contains(t, noChannels.handlerCovBody(), "at least one channel")

	// A failed LISTEN is 503, not 500: plue's event-stream tier refused the
	// stream, nothing was established, and reconnecting is the right move. 500
	// told the client plue is defective and gave it no pacing to come back on.
	badSingle := handlerCovNewRecorder()
	ServeSSE(badSingle, req, StreamConfig{Pool: pool, Channels: []string{"bad-channel"}})
	assert.Equal(t, http.StatusServiceUnavailable, badSingle.handlerCovCode())
	assert.Contains(t, badSingle.handlerCovBody(), "failed to start SSE listener")

	badMulti := handlerCovNewRecorder()
	ServeSSE(badMulti, req, StreamConfig{Pool: pool, Channels: []string{"good_channel", "bad-channel"}})
	assert.Equal(t, http.StatusServiceUnavailable, badMulti.handlerCovCode())
	assert.Contains(t, badMulti.handlerCovBody(), "failed to start SSE listener")
}

func TestHandler_Cov_ServeSSEStreamsSingleChannelEvent(t *testing.T) {
	applicationName := handlerCovChannel("handler_single_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	channel := handlerCovChannel("handler_single")
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Name: "handler_cov_single_active"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeSSE(rec, req, StreamConfig{
			Pool:              pool,
			Channels:          []string{channel},
			EventType:         "override",
			ActiveConnections: gauge,
			OnConnect: func(w http.ResponseWriter, _ *http.Request, flusher http.Flusher) {
				_, _ = fmt.Fprint(w, ": connected\n\n")
				flusher.Flush()
				close(ready)
			},
			FormatEventID: func(payload string) string {
				return "id_" + payload
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not call OnConnect")
	}
	assert.Equal(t, http.StatusOK, rec.handlerCovCode())
	assert.Equal(t, "text/event-stream", rec.Header().Get("Content-Type"))
	assert.Equal(t, 1.0, testutil.ToFloat64(gauge))
	assert.Contains(t, rec.handlerCovBody(), ": connected")

	handlerCovNotify(t, adminPool, channel, "single_payload")
	handlerCovWaitBodyContains(t, rec, "id: id_single_payload")
	handlerCovWaitBodyContains(t, rec, "event: override")
	handlerCovWaitBodyContains(t, rec, "data: single_payload")

	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))
	handlerCovWaitDone(t, done)
	cancel()
	assert.Equal(t, 0.0, testutil.ToFloat64(gauge))
}

func TestHandler_Cov_ServeSSEStreamsMultiChannelEventAndKeepAlive(t *testing.T) {
	applicationName := handlerCovChannel("handler_multi_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	first := handlerCovChannel("handler_multi_a")
	second := handlerCovChannel("handler_multi_b")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeSSE(rec, req, StreamConfig{
			Pool:      pool,
			Channels:  []string{first, second},
			KeepAlive: 5 * time.Millisecond,
			OnConnect: func(http.ResponseWriter, *http.Request, http.Flusher) {
				close(ready)
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not call OnConnect for multi-channel stream")
	}

	handlerCovNotify(t, adminPool, second, "multi_payload")
	handlerCovWaitBodyContains(t, rec, "event: "+second)
	handlerCovWaitBodyContains(t, rec, "data: multi_payload")
	handlerCovWaitBodyContains(t, rec, ": keep-alive")

	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))
	handlerCovWaitDone(t, done)
	cancel()
}

func TestHandler_Cov_ServeSSEReturnsWhenListenerEventsClose(t *testing.T) {
	applicationName := handlerCovChannel("handler_close_app")
	streamPool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	channel := handlerCovChannel("handler_close")

	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeSSE(rec, req, StreamConfig{
			Pool:      streamPool,
			Channels:  []string{channel},
			KeepAlive: time.Hour,
			OnConnect: func(http.ResponseWriter, *http.Request, http.Flusher) {
				close(ready)
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSSE did not establish listener before backend termination")
	}

	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))

	handlerCovWaitDone(t, done)
	assert.Equal(t, http.StatusOK, rec.handlerCovCode())
}

func TestHandler_Cov_ServeBrokerSSEWritesErrors(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/broker-events", nil)

	plain := handlerCovNewPlainWriter()
	ServeBrokerSSE(plain, req, BrokerStreamConfig{})
	assert.Equal(t, http.StatusInternalServerError, plain.code)
	assert.Contains(t, plain.body.String(), "streaming not supported")

	nilBroker := handlerCovNewRecorder()
	ServeBrokerSSE(nilBroker, req, BrokerStreamConfig{})
	assert.Equal(t, http.StatusInternalServerError, nilBroker.handlerCovCode())
	assert.Contains(t, nilBroker.handlerCovBody(), "broker is nil")

	subscribeErr := handlerCovNewRecorder()
	ServeBrokerSSE(subscribeErr, req, BrokerStreamConfig{
		Broker:  NewBroker(nil),
		Channel: "not_started_channel",
		UserID:  10,
	})
	// Same verdict as a failed LISTEN: the broker refused the subscription, so
	// the stream never existed.
	assert.Equal(t, http.StatusServiceUnavailable, subscribeErr.handlerCovCode())
	assert.Contains(t, subscribeErr.handlerCovBody(), "failed to subscribe")
}

func TestHandler_Cov_ServeBrokerSSEStreamsEventAndCleansUp(t *testing.T) {
	channel := handlerCovChannel("handler_broker")
	broker := NewBroker(nil)
	broker.channels[channel] = struct{}{}
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Name: "handler_cov_broker_active"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/broker-events", nil).WithContext(ctx)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeBrokerSSE(rec, req, BrokerStreamConfig{
			Broker:            broker,
			Channel:           channel,
			UserID:            77,
			ActiveConnections: gauge,
			OnConnect: func(http.ResponseWriter, *http.Request, http.Flusher) {
				close(ready)
			},
			FormatEventID: func(payload string) string {
				return "broker_" + payload
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeBrokerSSE did not call OnConnect")
	}
	assert.Equal(t, http.StatusOK, rec.handlerCovCode())
	assert.Contains(t, rec.handlerCovBody(), ": connected\n\n")
	assert.Equal(t, 1.0, testutil.ToFloat64(gauge))

	broker.dispatchNotification(channel, "broker_payload")
	handlerCovWaitBodyContains(t, rec, "id: broker_broker_payload")
	handlerCovWaitBodyContains(t, rec, "event: "+channel)
	handlerCovWaitBodyContains(t, rec, "data: broker_payload")

	cancel()
	handlerCovWaitDone(t, done)
	assert.Equal(t, 0.0, testutil.ToFloat64(gauge))
	assert.Empty(t, broker.userCounts)
	assert.Empty(t, broker.subscribers[channel])
}

func TestHandler_Cov_ServeBrokerSSEReturnsWhenSubscriptionClosed(t *testing.T) {
	channel := handlerCovChannel("handler_broker_closed")
	broker := NewBroker(nil)
	broker.channels[channel] = struct{}{}

	req := httptest.NewRequest(http.MethodGet, "/broker-events", nil)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeBrokerSSE(rec, req, BrokerStreamConfig{
			Broker:  broker,
			Channel: channel,
			UserID:  88,
			OnConnect: func(http.ResponseWriter, *http.Request, http.Flusher) {
				close(ready)
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeBrokerSSE did not subscribe")
	}

	broker.mu.Lock()
	require.Len(t, broker.subscribers[channel], 1)
	sub := broker.subscribers[channel][0]
	broker.mu.Unlock()

	broker.Unsubscribe(&Subscription{broker: broker, channels: []string{channel}, sub: sub})
	handlerCovWaitDone(t, done)
	assert.Equal(t, http.StatusOK, rec.handlerCovCode())
}

func TestHandler_Cov_ServeBrokerSSEWritesKeepAlive(t *testing.T) {
	channel := handlerCovChannel("handler_broker_keepalive")
	broker := NewBroker(nil)
	broker.channels[channel] = struct{}{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/broker-events", nil).WithContext(ctx)
	rec := handlerCovNewRecorder()
	ready := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ServeBrokerSSE(rec, req, BrokerStreamConfig{
			Broker:    broker,
			Channel:   channel,
			UserID:    99,
			KeepAlive: 5 * time.Millisecond,
			OnConnect: func(http.ResponseWriter, *http.Request, http.Flusher) {
				close(ready)
			},
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeBrokerSSE did not subscribe for keep-alive test")
	}

	handlerCovWaitBodyContains(t, rec, ": keep-alive")
	cancel()
	handlerCovWaitDone(t, done)
}

func TestHandler_Cov_IsTooManyStreamsFalse(t *testing.T) {
	var tooMany *ErrTooManyStreams
	assert.False(t, isTooManyStreams(errors.New("different error"), &tooMany))
	assert.Nil(t, tooMany)
}
