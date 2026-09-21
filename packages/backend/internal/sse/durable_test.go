package sse

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

func durableFixturePage(after int64, limit int, head int64) DurablePage {
	page := DurablePage{Cursor: after}
	// Deliberately sparse IDs: unrelated streams and rollbacks leave gaps.
	for id := after + 3; id <= head && len(page.Events) < limit; id += 3 {
		page.Events = append(page.Events, Event{ID: strconv.FormatInt(id, 10), Type: "record", Data: `{}`})
		page.Cursor = id
	}
	page.More = len(page.Events) == limit
	return page
}

func TestDurableStreamDrainsAllPagesAndDeduplicatesWakeups(t *testing.T) {
	stream := &DurableStream{Load: func(_ context.Context, after int64, limit int) (DurablePage, error) {
		return durableFixturePage(after, limit, 7503), nil
	}}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	req.Header.Set("Last-Event-ID", "3")
	rec := httptest.NewRecorder()
	stream.OnConnect(rec, req, rec)
	require.Equal(t, int64(7503), stream.cursor)
	require.Equal(t, 2500, strings.Count(rec.Body.String(), "event: record\n"))
	before := rec.Body.String()
	stream.OnConnect(rec, req, rec)
	stream.OnConnect(rec, req, rec)
	require.Equal(t, before, rec.Body.String(), "late, duplicate and out-of-order hints must never duplicate events")
}

func TestDurableStreamFailureRetriesSamePageAndReportsNoCursor(t *testing.T) {
	fail := true
	var afters []int64
	stream := &DurableStream{Load: func(_ context.Context, after int64, limit int) (DurablePage, error) {
		afters = append(afters, after)
		if after == 3003 && fail {
			return DurablePage{}, errors.New("database offline")
		}
		return durableFixturePage(after, limit, 4503), nil
	}}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	req.Header.Set("Last-Event-ID", "3")
	rec := httptest.NewRecorder()
	stream.OnConnect(rec, req, rec)
	require.Equal(t, int64(3003), stream.cursor)
	require.Contains(t, rec.Body.String(), "event: stream.error\ndata: {\"code\":\"replay_unavailable\",\"retryable\":true}\n\n")
	fail = false
	stream.OnConnect(rec, req, rec)
	require.Equal(t, []int64{3, 3003, 3003}, afters)
	require.Equal(t, 1500, strings.Count(rec.Body.String(), "event: record\n"))
}

func TestDurableStreamFilteredPageAdvancesWithoutDisclosingID(t *testing.T) {
	stream := &DurableStream{Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
		if after == 1 {
			return DurablePage{Cursor: 5000, More: true}, nil
		}
		return DurablePage{Cursor: 5001, Events: []Event{{ID: "5001", Type: "notification", Data: `{}`}}}, nil
	}}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	req.Header.Set("Last-Event-ID", "1")
	rec := httptest.NewRecorder()
	stream.OnConnect(rec, req, rec)
	require.NotContains(t, rec.Body.String(), "id: 5000")
	require.Contains(t, rec.Body.String(), "id: 5001")
	require.Equal(t, int64(5001), stream.cursor)
}

func TestDurableStreamRejectsBadPagesBeforeAnyOutput(t *testing.T) {
	for _, page := range []DurablePage{
		{Cursor: 9, Events: []Event{{ID: "9"}, {ID: "8"}}},
		{Cursor: 9, Events: []Event{{ID: "9"}, {ID: "9"}}},
		{Cursor: 8, Events: []Event{{ID: "9"}}},
		{Cursor: 1, More: true},
	} {
		stream := &DurableStream{Load: func(context.Context, int64, int) (DurablePage, error) { return page, nil }}
		req := httptest.NewRequest(http.MethodGet, "/stream", nil)
		req.Header.Set("Last-Event-ID", "1")
		rec := httptest.NewRecorder()
		stream.OnConnect(rec, req, rec)
		require.Equal(t, int64(1), stream.cursor)
		require.NotContains(t, rec.Body.String(), "id:")
		require.Contains(t, rec.Body.String(), "stream.error")
	}
}

func TestDurableStreamFreshConnectionsStartAtHeadAndRetryHeadFailure(t *testing.T) {
	for _, raw := range []string{"", "0", "invalid", "-1"} {
		t.Run(raw, func(t *testing.T) {
			attempts := 0
			stream := &DurableStream{
				Head: func(context.Context) (int64, error) {
					attempts++
					if attempts == 1 {
						return 0, errors.New("offline")
					}
					return 99, nil
				},
				Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
					require.Equal(t, int64(99), after)
					return DurablePage{Cursor: after}, nil
				},
			}
			req := httptest.NewRequest(http.MethodGet, "/stream", nil)
			req.Header.Set("Last-Event-ID", raw)
			rec := httptest.NewRecorder()
			stream.OnConnect(rec, req, rec)
			require.False(t, stream.initialized)
			stream.OnConnect(rec, req, rec)
			require.True(t, stream.initialized)
			require.Equal(t, int64(99), stream.cursor)
			require.NotContains(t, rec.Body.String(), "id:")
		})
	}
}

func TestDurableBrokerRepairsMissingWakeupAndUsesDatabasePayload(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var mu sync.Mutex
	head := int64(1)
	caught := make(chan struct{})
	var once sync.Once
	stream := &DurableStream{
		PollInterval: time.Millisecond,
		Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
			mu.Lock()
			current := head
			mu.Unlock()
			if current > after {
				return DurablePage{Cursor: current, Events: []Event{{ID: strconv.FormatInt(current, 10), Type: "record", Data: `{"source":"database"}`}}}, nil
			}
			if after == 2 {
				once.Do(func() { close(caught) })
			}
			return DurablePage{Cursor: after}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
	req.Header.Set("Last-Event-ID", "1")
	rec := httptest.NewRecorder()
	hints := make(chan Event, 4)
	done := make(chan struct{})
	go func() {
		defer close(done)
		serveDurableBroker(rec, req, rec, BrokerStreamConfig{Durable: stream}, hints, nil, time.Second)
	}()
	mu.Lock()
	head = 2
	mu.Unlock() // committed row, deliberately no NOTIFY
	select {
	case <-caught:
	case <-ctx.Done():
		t.Fatal("periodic repair missed committed row")
	}
	hints <- Event{ID: "999", Data: `{"source":"untrusted-notify"}`}
	hints <- Event{ID: "1", Data: `{}`}
	close(hints)
	<-done
	require.Equal(t, 1, strings.Count(rec.Body.String(), "id: 2\n"))
	require.Contains(t, rec.Body.String(), `"source":"database"`)
	require.NotContains(t, rec.Body.String(), "999")
	require.NotContains(t, rec.Body.String(), "untrusted-notify")
}

func TestDurableBrokerRevocationCancelsCatchUpQuery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := make(chan struct{})
	revoked := make(chan revocation.Event, 1)
	stream := &DurableStream{Load: func(ctx context.Context, _ int64, _ int) (DurablePage, error) {
		close(started)
		<-ctx.Done()
		return DurablePage{}, ctx.Err()
	}}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx)
	req.Header.Set("Last-Event-ID", "1")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		serveDurableBroker(rec, req, rec, BrokerStreamConfig{Durable: stream}, make(chan Event), revoked, time.Second)
	}()
	<-started
	revoked <- revocation.Event{}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("revocation did not cancel database catch-up")
	}
	require.Equal(t, 1, strings.Count(rec.Body.String(), "event: revoked"))
	require.NotContains(t, rec.Body.String(), "stream.error")
}

type durableReadyRecorder struct {
	*httptest.ResponseRecorder
	onFlush func()
}

func (r *durableReadyRecorder) Flush() { r.ResponseRecorder.Flush(); r.onFlush() }

func TestDurableBrokerBaselinePrecedesReadyFrame(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	head := int64(1)
	rec := &durableReadyRecorder{ResponseRecorder: httptest.NewRecorder()}
	ready := false
	rec.onFlush = func() {
		if !ready {
			ready = true
			head = 2
		} // Client commits immediately on readiness.
		if strings.Contains(rec.Body.String(), "id: 2\n") {
			cancel()
		}
	}
	stream := &DurableStream{
		Head: func(context.Context) (int64, error) { return head, nil },
		Load: func(_ context.Context, after int64, _ int) (DurablePage, error) {
			page := DurablePage{Cursor: after}
			if head > after {
				page.Cursor = head
				page.Events = []Event{{ID: strconv.FormatInt(head, 10), Type: "record", Data: `{}`}}
			}
			return page, nil
		},
	}
	broker := newRunningBroker()
	t.Cleanup(broker.Stop)
	ServeBrokerSSE(rec, httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx), BrokerStreamConfig{Broker: broker, Channel: "fresh_stream", UserID: 1, Durable: stream})
	require.Contains(t, rec.Body.String(), ": connected")
	require.Contains(t, rec.Body.String(), "id: 2\n", "a write after readiness must not be mistaken for historical state")
	require.NotContains(t, rec.Body.String(), "id: 1\n")
}

func TestDurableBrokerHeadFailureRefusesReadiness(t *testing.T) {
	stream := &DurableStream{Head: func(context.Context) (int64, error) { return 0, errors.New("offline") }}
	rec := httptest.NewRecorder()
	broker := newRunningBroker()
	t.Cleanup(broker.Stop)
	ServeBrokerSSE(rec, httptest.NewRequest(http.MethodGet, "/stream", nil), BrokerStreamConfig{Broker: broker, Channel: "fresh_stream", UserID: 1, Durable: stream})
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.NotContains(t, rec.Body.String(), ": connected")
}

func TestDurableBrokerRevocationDuringHeadPreventsReadiness(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	broker := newRunningBroker()
	t.Cleanup(broker.Stop)
	watcher := &fakeWatcher{event: revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}, fire: make(chan struct{})}
	headStarted := make(chan struct{})
	headCancelled := make(chan struct{})
	stream := &DurableStream{
		Head: func(ctx context.Context) (int64, error) {
			close(headStarted)
			<-ctx.Done()
			close(headCancelled)
			return 0, ctx.Err()
		},
		Load: func(context.Context, int64, int) (DurablePage, error) {
			t.Error("revoked stream must not load data")
			return DurablePage{}, nil
		},
	}
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ServeBrokerSSE(rec, httptest.NewRequest(http.MethodGet, "/stream", nil).WithContext(ctx), BrokerStreamConfig{Broker: broker, Channel: "notification_facts_7", UserID: 7, Revocations: watcher, Durable: stream})
	}()
	<-headStarted
	close(watcher.fire)
	select {
	case <-headCancelled:
	case <-ctx.Done():
		t.Fatal("revocation did not cancel baseline head read")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("revoked stream did not return")
	}
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.NotContains(t, rec.Body.String(), ": connected")
	require.NotContains(t, rec.Body.String(), "event:")
}

func TestDurableBrokerRechecksCachedRevocationBeforeHead(t *testing.T) {
	for _, event := range []revocation.Event{
		{Kind: revocation.KindUserDisabled, UserID: 7, CreatedAt: time.Now()},
		{Kind: revocation.KindTokenRevoked, TokenHash: "token-7", CreatedAt: time.Now()},
	} {
		bus := revocation.NewBus(nil, nil)
		bus.Deliver(event)
		broker := newRunningBroker()
		t.Cleanup(broker.Stop)
		rec := httptest.NewRecorder()
		ServeBrokerSSE(rec, httptest.NewRequest(http.MethodGet, "/stream", nil), BrokerStreamConfig{Broker: broker, Channel: "cached_revocation", UserID: 7, Principal: revocation.Principal{UserID: 7, TokenHash: "token-7"}, Revocations: bus, Durable: &DurableStream{Head: func(context.Context) (int64, error) {
			t.Fatal("cached revocation must be checked before head")
			return 0, nil
		}}})
		require.Equal(t, http.StatusForbidden, rec.Code)
		require.NotContains(t, rec.Body.String(), ": connected")
	}
}
