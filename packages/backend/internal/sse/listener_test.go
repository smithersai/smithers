package sse

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- fakeNotifier for unit testing ----

// fakeNotifier simulates a PostgreSQL LISTEN connection without a real database.
// It queues payloads that waitForNotification drains in order.
type fakeNotifier struct {
	mu           sync.Mutex
	payloads     []string
	released     bool
	releaseCount int
	// blockUntilClose causes waitForNotification to block until ctx is canceled.
	blockUntilClose bool
}

func (f *fakeNotifier) waitForNotification(ctx context.Context) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		f.mu.Lock()
		if len(f.payloads) > 0 {
			p := f.payloads[0]
			f.payloads = f.payloads[1:]
			f.mu.Unlock()
			return p, nil
		}
		f.mu.Unlock()
		// If blockUntilClose, block on ctx; otherwise yield and retry.
		if f.blockUntilClose {
			<-ctx.Done()
			return "", ctx.Err()
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *fakeNotifier) release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = true
	f.releaseCount++
}

func (f *fakeNotifier) addPayload(p string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.payloads = append(f.payloads, p)
}

// ---- tests ----

func TestListener_Events_ReceivesPayloads(t *testing.T) {
	t.Parallel()

	fake := &fakeNotifier{}
	fake.addPayload(`{"id":1}`)
	fake.addPayload(`{"id":2}`)

	l := newListenerFromNotifier(fake, "test_channel")
	defer l.Close()

	events := l.Events()

	e1 := <-events
	assert.Equal(t, "message", e1.Type)
	assert.Equal(t, `{"id":1}`, e1.Data)

	e2 := <-events
	assert.Equal(t, "message", e2.Type)
	assert.Equal(t, `{"id":2}`, e2.Data)
}

func TestListener_Close_ReleasesConnection(t *testing.T) {
	t.Parallel()

	fake := &fakeNotifier{blockUntilClose: true}
	l := newListenerFromNotifier(fake, "test_channel")

	l.Close()

	// Give goroutine time to observe Close.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		released := fake.released
		fake.mu.Unlock()
		if released {
			break
		}
		time.Sleep(time.Millisecond)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	assert.True(t, fake.released, "Close() must release the notifier connection")
}

func TestListener_Close_IsIdempotent(t *testing.T) {
	t.Parallel()

	fake := &fakeNotifier{blockUntilClose: true}
	l := newListenerFromNotifier(fake, "test_channel")

	// Calling Close twice must not panic.
	require.NotPanics(t, func() {
		l.Close()
		l.Close()
	})

	fake.mu.Lock()
	defer fake.mu.Unlock()
	assert.Equal(t, 1, fake.releaseCount, "Close() must release the notifier only once")
}

func TestListener_EventsChannel_ClosedAfterStop(t *testing.T) {
	t.Parallel()

	fake := &fakeNotifier{blockUntilClose: true}
	l := newListenerFromNotifier(fake, "test_channel")

	l.Close()

	// Events channel must eventually be closed so range loops terminate.
	select {
	case _, ok := <-l.Events():
		assert.False(t, ok, "events channel must be closed after listener is stopped")
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for events channel to close")
	}
}

func TestListener_ErrorFromNotifier_StopsGoroutine(t *testing.T) {
	t.Parallel()

	// notifier that returns an error on the first call.
	errNotifier := &errorNotifier{err: errors.New("connection reset")}
	l := newListenerFromNotifier(errNotifier, "test_channel")
	defer l.Close()

	// events channel should be closed once the error causes the goroutine to exit.
	select {
	case _, ok := <-l.Events():
		assert.False(t, ok, "events channel must close when notifier errors")
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for events channel to close on error")
	}
}

// errorNotifier always returns an error from waitForNotification.
type errorNotifier struct {
	err error
}

func (e *errorNotifier) waitForNotification(_ context.Context) (string, error) {
	return "", e.err
}

func (e *errorNotifier) release() {}

type fakeMultiNotifier struct {
	mu           sync.Mutex
	released     bool
	releaseCount int
}

func (f *fakeMultiNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	<-ctx.Done()
	return "", "", ctx.Err()
}

func (f *fakeMultiNotifier) release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = true
	f.releaseCount++
}

func (f *fakeMultiNotifier) listen(_ context.Context, _ string) error {
	return nil
}

func TestMultiListener_Close_IsIdempotent(t *testing.T) {
	t.Parallel()

	fake := &fakeMultiNotifier{}
	l := &MultiListener{
		n:          fake,
		channels:   []string{"notifications"},
		events:     make(chan Event, 1),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	go l.listen()

	require.NotPanics(t, func() {
		l.Close()
		l.Close()
	})

	fake.mu.Lock()
	defer fake.mu.Unlock()
	assert.True(t, fake.released, "Close() must release the notifier connection")
	assert.Equal(t, 1, fake.releaseCount, "Close() must release the notifier only once")
}

// slowExitMultiNotifier simulates a WaitForNotification whose teardown takes a
// moment after cancellation, to catch Close() releasing the pooled connection
// while the wait is still in flight.
type slowExitMultiNotifier struct {
	waitExited         sync.WaitGroup
	releasedBeforeExit bool
	exited             bool
	mu                 sync.Mutex
}

func (n *slowExitMultiNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	<-ctx.Done()
	time.Sleep(20 * time.Millisecond) // in-flight teardown after cancellation
	n.mu.Lock()
	n.exited = true
	n.mu.Unlock()
	return "", "", ctx.Err()
}

func (n *slowExitMultiNotifier) release() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.exited {
		n.releasedBeforeExit = true
	}
}

func (n *slowExitMultiNotifier) listen(context.Context, string) error { return nil }

// TestMultiListener_Close_WaitsForListenGoroutine locks the fix for the
// use-after-release race: Close() must not return the pooled connection while
// the listen goroutine may still be inside WaitForNotification on it.
func TestMultiListener_Close_WaitsForListenGoroutine(t *testing.T) {
	t.Parallel()

	fake := &slowExitMultiNotifier{}
	l := &MultiListener{
		n:          fake,
		channels:   []string{"notifications"},
		events:     make(chan Event, 1),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	go l.listen()

	// Let the goroutine enter the wait before closing.
	time.Sleep(10 * time.Millisecond)
	l.Close()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	assert.True(t, fake.exited, "Close() returned before the listen goroutine exited")
	assert.False(t, fake.releasedBeforeExit,
		"connection was released while WaitForNotification was still in flight (use-after-release race)")
}

// ---- validateChannel tests ----

func TestValidateChannel_AcceptsValidNames(t *testing.T) {
	t.Parallel()

	valid := []string{
		"notifications",
		"agent_session_123",
		"user_42",
		"WorkflowLog",
		"a",
		"Z",
		"_",
		"_underscore_start",
	}
	for _, name := range valid {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.NoError(t, validateChannel(name))
		})
	}
}

func TestValidateChannel_RejectsInvalidNames(t *testing.T) {
	t.Parallel()

	invalid := []string{
		"",
		"has space",
		"has-hyphen",
		"has.dot",
		"has;semicolon",
		"DROP TABLE notifications; --",
		"chan'nel",
		"chan\"nel",
		"chan$nel",
	}
	for _, name := range invalid {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Error(t, validateChannel(name))
		})
	}
}

func TestValidateChannel_EmptyName_ReturnsError(t *testing.T) {
	t.Parallel()
	err := validateChannel("")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty")
}

// ---- FormatEvent tests ----

func TestFormatEvent_WithIDAndType(t *testing.T) {
	t.Parallel()

	e := Event{Type: "notification", Data: `{"id":42}`, ID: "42"}
	got := FormatEvent(e)
	assert.Contains(t, got, "id: 42\n")
	assert.Contains(t, got, "event: notification\n")
	assert.Contains(t, got, "data: {\"id\":42}\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"), "must end with double newline")
}

func TestFormatEvent_WithoutID(t *testing.T) {
	t.Parallel()

	e := Event{Type: "notification", Data: `{"id":99}`}
	got := FormatEvent(e)
	assert.NotContains(t, got, "id:")
	assert.Contains(t, got, "event: notification\n")
	assert.Contains(t, got, "data: {\"id\":99}\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}

func TestFormatEvent_WithoutType(t *testing.T) {
	t.Parallel()

	e := Event{Data: `hello`, ID: "1"}
	got := FormatEvent(e)
	assert.Contains(t, got, "id: 1\n")
	assert.NotContains(t, got, "event:")
	assert.Contains(t, got, "data: hello\n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}

func TestFormatEvent_EmptyEvent(t *testing.T) {
	t.Parallel()

	e := Event{}
	got := FormatEvent(e)
	assert.Contains(t, got, "data: \n")
	assert.True(t, strings.HasSuffix(got, "\n\n"))
}
