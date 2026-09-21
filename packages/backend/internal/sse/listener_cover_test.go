package sse

import (
	"context"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var listenerCovChannelSeq uint64

func listenerCovChannel(prefix string) string {
	n := atomic.AddUint64(&listenerCovChannelSeq, 1)
	return prefix + "_cov_" + strconv.FormatInt(time.Now().UnixNano(), 36) + "_" + strconv.FormatUint(n, 36)
}

func listenerCovNotify(t *testing.T, pool *pgxpool.Pool, channel, payload string) {
	t.Helper()
	covNotify(t, pool, channel, payload)
}

type listenerCovOnePayloadNotifier struct {
	payload string
}

func (n listenerCovOnePayloadNotifier) waitForNotification(context.Context) (string, error) {
	return n.payload, nil
}

func (n listenerCovOnePayloadNotifier) release() {}

type listenerCovOneMultiNotifier struct {
	channel string
	payload string
}

func (n listenerCovOneMultiNotifier) waitForNotificationWithChannel(context.Context) (string, string, error) {
	return n.channel, n.payload, nil
}

func (n listenerCovOneMultiNotifier) release() {}

func TestListener_Cov_NewListenerReceivesPostgresNotification(t *testing.T) {
	applicationName := listenerCovChannel("listener_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	channel := listenerCovChannel("listener")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	listener, err := NewListener(ctx, pool, channel)
	require.NoError(t, err)

	listenerCovNotify(t, adminPool, channel, "single_payload")

	select {
	case event := <-listener.Events():
		assert.Equal(t, "message", event.Type)
		assert.Equal(t, "single_payload", event.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("listener did not receive PostgreSQL notification")
	}

	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))
	select {
	case _, ok := <-listener.Events():
		assert.False(t, ok)
	case <-time.After(2 * time.Second):
		t.Fatal("listener events did not close")
	}
	listener.Close()
}

func TestListener_Cov_NewListenerErrors(t *testing.T) {
	pool := brokerCovPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := NewListener(ctx, pool, "bad-channel")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid character")

	canceledCtx, cancelCanceled := context.WithCancel(context.Background())
	cancelCanceled()
	_, err = NewListener(canceledCtx, pool, listenerCovChannel("listener_acquire"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "acquire connection")

	_, err = NewListener(ctx, pool, "select")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "LISTEN select")
}

func TestListener_Cov_ListenReturnsWhenDoneDuringSend(t *testing.T) {
	listener := &Listener{
		n:          listenerCovOnePayloadNotifier{payload: "blocked_payload"},
		events:     make(chan Event),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	close(listener.done)

	listener.listen()

	select {
	case _, ok := <-listener.Events():
		assert.False(t, ok)
	default:
		t.Fatal("listener events channel should be closed after done wins send select")
	}
}

func TestListener_Cov_NewMultiListenerReceivesPostgresNotification(t *testing.T) {
	applicationName := listenerCovChannel("multi_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	first := listenerCovChannel("multi_a")
	second := listenerCovChannel("multi_b")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	listener, err := NewMultiListener(ctx, pool, []string{first, second})
	require.NoError(t, err)
	assert.Equal(t, []string{first, second}, listener.channels)

	listenerCovNotify(t, adminPool, second, "multi_payload")

	select {
	case event := <-listener.Events():
		assert.Equal(t, second, event.Type)
		assert.Equal(t, "multi_payload", event.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("multi-listener did not receive PostgreSQL notification")
	}

	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))
	select {
	case _, ok := <-listener.Events():
		assert.False(t, ok)
	case <-time.After(2 * time.Second):
		t.Fatal("multi-listener events did not close")
	}
	listener.Close()
}

func TestListener_Cov_NewMultiListenerErrors(t *testing.T) {
	pool := brokerCovPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := NewMultiListener(ctx, pool, []string{"ok_channel", "bad-channel"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid character")

	canceledCtx, cancelCanceled := context.WithCancel(context.Background())
	cancelCanceled()
	_, err = NewMultiListener(canceledCtx, pool, []string{listenerCovChannel("multi_acquire")})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "acquire connection")

	_, err = NewMultiListener(ctx, pool, []string{listenerCovChannel("multi_ok"), "select"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "LISTEN select")
}

func TestListener_Cov_MultiListenReturnsWhenDoneDuringSend(t *testing.T) {
	listener := &MultiListener{
		n:          listenerCovOneMultiNotifier{channel: "blocked_channel", payload: "blocked_payload"},
		events:     make(chan Event),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	close(listener.done)

	listener.listen()

	select {
	case _, ok := <-listener.Events():
		assert.False(t, ok)
	default:
		t.Fatal("multi-listener events channel should be closed after done wins send select")
	}
}
