package jobs

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func singleConnectionStore(t *testing.T) *Store {
	t.Helper()
	schemaStore := newTestStore(t)
	config := schemaStore.pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	store, err := NewStore(pool)
	require.NoError(t, err)
	return store
}

func TestSubscriptionReplaysWithOnePoolConnection(t *testing.T) {
	store := singleConnectionStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	receipt, err := store.Admit(t.Context(), testAdmission(scope, "before-subscribe", EffectIdempotent, `{"n":1}`))
	require.NoError(t, err)
	subscription, err := store.Subscribe(t.Context(), scope, 0, time.Second, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancel()
	event, err := subscription.Next(ctx)
	require.NoError(t, err, "the listener must not occupy the pool's last replay connection")
	require.Equal(t, receipt.OperationID, event.OperationID)
}

func TestSubscriptionLeavesAdmissionCapacityAvailable(t *testing.T) {
	store := singleConnectionStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	subscription, err := store.Subscribe(t.Context(), scope, 0, time.Second, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancel()
	receipt, err := store.Admit(ctx, testAdmission(scope, "while-subscribed", EffectIdempotent, `{"n":1}`))
	require.NoError(t, err, "an idle listener must not block admission")
	event, err := subscription.Next(ctx)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, event.OperationID)
	require.NoError(t, subscription.Close(ctx))
	_, err = subscription.Next(ctx)
	require.ErrorContains(t, err, "subscription is closed")
}

func TestConcurrentSubscriptionsPollOnePoolConnection(t *testing.T) {
	store := singleConnectionStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	const count = 8
	ready := make(chan struct{}, count)
	type result struct {
		event Event
		err   error
	}
	results := make(chan result, count)
	for range count {
		var once sync.Once
		subscription, err := store.Subscribe(ctx, scope, 0, 10*time.Millisecond,
			func(context.Context, Scope) error {
				once.Do(func() { ready <- struct{}{} })
				return nil
			})
		require.NoError(t, err)
		defer func() { require.NoError(t, subscription.Close(context.Background())) }()
		go func() {
			event, err := subscription.Next(ctx)
			results <- result{event: event, err: err}
		}()
	}
	for range count {
		waitWorkerSignal(t, ready, "subscription replay")
	}
	receipt, err := store.Admit(ctx, testAdmission(scope, "while-polling", EffectIdempotent, `{"n":1}`))
	require.NoError(t, err)
	for range count {
		got := waitWorkerSignal(t, results, "polled event")
		require.NoError(t, got.err)
		require.Equal(t, receipt.OperationID, got.event.OperationID)
	}
}

func TestSubscriptionCloseInterruptsPendingNext(t *testing.T) {
	store := singleConnectionStore(t)
	ready := make(chan struct{})
	var once sync.Once
	subscription, err := store.Subscribe(t.Context(), Scope{TenantID: "tenant", PrincipalID: "owner"}, 0, time.Hour,
		func(context.Context, Scope) error { once.Do(func() { close(ready) }); return nil })
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := subscription.Next(ctx); done <- err }()
	waitWorkerSignal(t, ready, "pending Next")
	closedContext, cancelClose := context.WithCancel(context.Background())
	cancelClose()
	require.NoError(t, subscription.Close(closedContext))
	select {
	case err := <-done:
		require.Error(t, err)
		require.False(t, errors.Is(err, context.DeadlineExceeded), "Close must interrupt the pending poll")
	case <-time.After(time.Second):
		t.Fatal("Close left Next waiting for its poll interval")
	}
	require.NoError(t, subscription.Close(closedContext))
}

func TestSubscriptionCloseInterruptsPoolAcquire(t *testing.T) {
	store := singleConnectionStore(t)
	ready := make(chan struct{})
	var once sync.Once
	subscription, err := store.Subscribe(t.Context(), Scope{TenantID: "tenant", PrincipalID: "owner"}, 0, time.Second,
		func(context.Context, Scope) error { once.Do(func() { close(ready) }); return nil })
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	connection, err := store.pool.Acquire(t.Context())
	require.NoError(t, err)
	defer connection.Release()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := subscription.Next(ctx); done <- err }()
	waitWorkerSignal(t, ready, "pool acquisition")
	require.NoError(t, subscription.Close(t.Context()))
	select {
	case err := <-done:
		require.Error(t, err)
		require.False(t, errors.Is(err, context.DeadlineExceeded))
	case <-time.After(time.Second):
		t.Fatal("Close left Next waiting for a database connection")
	}
}

func TestCancelledNextPreservesBufferedCursor(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	for _, requestID := range []string{"first", "second"} {
		_, err := store.Admit(t.Context(), testAdmission(scope, requestID, EffectIdempotent, `{}`))
		require.NoError(t, err)
	}
	subscription, err := store.Subscribe(t.Context(), scope, 0, time.Second, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	_, err = subscription.Next(t.Context())
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = subscription.Next(ctx)
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, int64(1), subscription.Cursor())
	event, err := subscription.Next(t.Context())
	require.NoError(t, err)
	require.Equal(t, int64(2), event.Sequence)
}

func TestSubscriptionRetriesReplayAfterDatabaseError(t *testing.T) {
	store := singleConnectionStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	subscription, err := store.Subscribe(t.Context(), scope, 0, time.Second, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, subscription.Close(context.Background())) }()
	_, err = store.pool.Exec(t.Context(), `ALTER TABLE product_job_streams RENAME TO unavailable_streams`)
	require.NoError(t, err)
	_, err = subscription.Next(t.Context())
	require.Error(t, err)
	require.Zero(t, subscription.Cursor())
	_, err = store.pool.Exec(t.Context(), `ALTER TABLE unavailable_streams RENAME TO product_job_streams`)
	require.NoError(t, err)
	receipt, err := store.Admit(t.Context(), testAdmission(scope, "after-database-error", EffectIdempotent, `{}`))
	require.NoError(t, err)
	event, err := subscription.Next(t.Context())
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, event.OperationID)
	require.Equal(t, int64(1), subscription.Cursor())
}
