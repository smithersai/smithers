// Package sse provides utilities for Server-Sent Events backed by PostgreSQL LISTEN/NOTIFY.
package sse

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Event represents a single SSE event to be sent to a client.
type Event struct {
	// Type is the SSE event type (e.g. "message", "notification", "log").
	Type string
	// Data is the payload for the event (typically JSON).
	Data string
	// ID is an optional event ID for client-side Last-Event-ID tracking.
	ID string
}

// notifier is the minimal subset of a pgx connection used by Listener.
// This interface enables unit testing without a real PostgreSQL connection.
type notifier interface {
	// waitForNotification blocks until a NOTIFY arrives on the subscribed channel.
	waitForNotification(ctx context.Context) (payload string, err error)
	// release returns the underlying connection to the pool.
	release()
}

// pgxNotifier adapts a *pgxpool.Conn to the notifier interface.
type pgxNotifier struct {
	conn *pgxpool.Conn
}

func (p *pgxNotifier) waitForNotification(ctx context.Context) (string, error) {
	n, err := p.conn.Conn().WaitForNotification(ctx)
	if err != nil {
		return "", err
	}
	return n.Payload, nil
}

func (p *pgxNotifier) release() {
	p.conn.Release()
}

// Listener subscribes to a PostgreSQL LISTEN channel and emits Event values.
// It holds a dedicated pgxpool connection for the duration of the subscription.
type Listener struct {
	n          notifier
	channel    string
	events     chan Event
	done       chan struct{}
	listenDone chan struct{}
	close      sync.Once
}

// NewListener acquires a dedicated connection from pool, issues LISTEN on channel,
// and starts a background goroutine forwarding PostgreSQL notifications to Events().
// The caller MUST call Close() when done to release the connection.
//
// The channel name must consist only of ASCII letters, digits, and underscores
// to prevent SQL injection via the LISTEN statement.
func NewListener(ctx context.Context, pool *pgxpool.Pool, channel string) (*Listener, error) {
	if err := validateChannel(channel); err != nil {
		return nil, err
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("sse: acquire connection: %w", err)
	}

	// #nosec G202 — channel has been validated to contain only safe identifier chars.
	if _, err = conn.Exec(ctx, "LISTEN "+channel); err != nil {
		conn.Release()
		return nil, fmt.Errorf("sse: LISTEN %s: %w", channel, err)
	}

	return newListenerFromNotifier(&pgxNotifier{conn: conn}, channel), nil
}

// newListenerFromNotifier is the internal constructor used by both NewListener and tests.
func newListenerFromNotifier(n notifier, channel string) *Listener {
	l := &Listener{
		n:          n,
		channel:    channel,
		events:     make(chan Event, 100),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	go l.listen()
	return l
}

// Events returns the read-only channel of incoming events.
// The channel is closed when the listener is stopped.
func (l *Listener) Events() <-chan Event {
	return l.events
}

// Close stops the listener goroutine and releases the PostgreSQL connection.
// It is safe to call Close multiple times.
func (l *Listener) Close() {
	l.close.Do(func() {
		close(l.done)
		// Wait for the listen goroutine to stop touching the connection before
		// releasing it, so release() never races an in-flight WaitForNotification
		// on the same pooled connection (a client disconnect could otherwise
		// panic with a nil pointer dereference).
		<-l.listenDone
		l.n.release()
	})
}

// listen is the background goroutine that waits for PostgreSQL notifications.
func (l *Listener) listen() {
	defer close(l.events)
	// Signal Close() that the goroutine has stopped using the connection, so it
	// can safely release it without racing an in-flight WaitForNotification.
	defer close(l.listenDone)

	// Use a cancellable context tied to the done channel so WaitForNotification unblocks.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		<-l.done
		cancel()
	}()

	for {
		payload, err := l.n.waitForNotification(ctx)
		if err != nil {
			return
		}

		event := Event{Type: "message", Data: payload}
		select {
		case l.events <- event:
		case <-l.done:
			return
		}
	}
}

// validateChannel rejects channel names that could be used for SQL injection
// via the raw LISTEN statement. PostgreSQL channel names must be simple identifiers.
func validateChannel(channel string) error {
	if channel == "" {
		return fmt.Errorf("sse: channel name must not be empty")
	}
	for _, c := range channel {
		if !isChannelChar(c) {
			return fmt.Errorf("sse: channel name %q contains invalid character %q", channel, c)
		}
	}
	return nil
}

func isChannelChar(c rune) bool {
	return (c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9') ||
		c == '_'
}

// multiNotifier adapts a *pgxpool.Conn to provide channel-aware notifications.
type multiNotifier interface {
	// waitForNotificationWithChannel blocks until a NOTIFY arrives and returns both channel and payload.
	waitForNotificationWithChannel(ctx context.Context) (channel string, payload string, err error)
	// release returns the underlying connection to the pool.
	release()
}

type brokerNotifier interface {
	multiNotifier
	listen(ctx context.Context, channel string) error
	unlisten(ctx context.Context, channel string) error
}

// pgxMultiNotifier adapts a *pgxpool.Conn for multi-channel listening.
type pgxMultiNotifier struct {
	conn *pgxpool.Conn
}

func (p *pgxMultiNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	n, err := p.conn.Conn().WaitForNotification(ctx)
	if err != nil {
		return "", "", err
	}
	return n.Channel, n.Payload, nil
}

func (p *pgxMultiNotifier) release() {
	p.conn.Release()
}

// discard takes the connection out of the pool and closes its socket. Unlike
// release it is safe while another goroutine is still blocked on the conn:
// closing the net.Conn fails that call instead of sharing the conn.
func (p *pgxMultiNotifier) discard() {
	raw := p.conn.Hijack()
	_ = raw.PgConn().Conn().Close()
}

// discarder is implemented by notifiers that can drop their physical
// connection without returning it to the pool.
type discarder interface {
	discard()
}

// discardNotifier drops n's connection. A notifier that cannot discard is
// leaked rather than released, because release could share a conn still in use.
func discardNotifier(n multiNotifier) {
	if d, ok := n.(discarder); ok {
		d.discard()
	}
}

func (p *pgxMultiNotifier) listen(ctx context.Context, channel string) error {
	// #nosec G202 — callers validate channel before invoking listen.
	_, err := p.conn.Exec(ctx, "LISTEN "+channel)
	return err
}

func (p *pgxMultiNotifier) unlisten(ctx context.Context, channel string) error {
	// #nosec G202 — channel was validated when it was first LISTENed.
	_, err := p.conn.Exec(ctx, "UNLISTEN "+channel)
	return err
}

// MultiListener subscribes to multiple PostgreSQL LISTEN channels on a single
// connection and emits Event values with the channel name as the event Type.
type MultiListener struct {
	n          multiNotifier
	channels   []string
	events     chan Event
	done       chan struct{}
	listenDone chan struct{}
	close      sync.Once
}

// NewMultiListener acquires a single dedicated connection from pool, issues LISTEN
// on each channel, and starts a background goroutine forwarding notifications.
// The Event.Type field is set to the notification channel name so callers can
// distinguish between different event sources.
func NewMultiListener(ctx context.Context, pool *pgxpool.Pool, channels []string) (*MultiListener, error) {
	for _, ch := range channels {
		if err := validateChannel(ch); err != nil {
			return nil, err
		}
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("sse: acquire connection: %w", err)
	}

	for _, ch := range channels {
		// #nosec G202 — channel has been validated to contain only safe identifier chars.
		if _, err = conn.Exec(ctx, "LISTEN "+ch); err != nil {
			conn.Release()
			return nil, fmt.Errorf("sse: LISTEN %s: %w", ch, err)
		}
	}

	l := &MultiListener{
		n:          &pgxMultiNotifier{conn: conn},
		channels:   channels,
		events:     make(chan Event, 100),
		done:       make(chan struct{}),
		listenDone: make(chan struct{}),
	}
	go l.listen()
	return l, nil
}

// Events returns the read-only channel of incoming events.
func (l *MultiListener) Events() <-chan Event {
	return l.events
}

// Close stops the listener goroutine and releases the PostgreSQL connection.
func (l *MultiListener) Close() {
	l.close.Do(func() {
		close(l.done)
		// Wait for the listen goroutine to stop touching the connection before
		// releasing it, so release() never races an in-flight WaitForNotification
		// on the same pooled connection (a client disconnect could otherwise
		// hand the conn to another request while the wait is still live).
		<-l.listenDone
		l.n.release()
	})
}

func (l *MultiListener) listen() {
	defer close(l.events)
	// Signal Close() that the goroutine has stopped using the connection, so it
	// can safely release it without racing an in-flight WaitForNotification.
	defer close(l.listenDone)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		<-l.done
		cancel()
	}()

	for {
		channel, payload, err := l.n.waitForNotificationWithChannel(ctx)
		if err != nil {
			return
		}

		event := Event{Type: channel, Data: payload}
		select {
		case l.events <- event:
		case <-l.done:
			return
		}
	}
}

// FormatEvent serializes an Event into the SSE wire format.
// The output includes "id:", "event:", and "data:" fields as appropriate,
// terminated by a double newline.
//
// Example output with all fields set:
//
//	id: 42
//	event: notification
//	data: {"id":42}
//
// If ID is empty, the "id:" line is omitted.
// If Type is empty, the "event:" line is omitted.
//
// SSE treats CR, LF, and CRLF as line terminators. Data is split on each of
// them into one "data:" line per payload line, which the client rejoins with
// "\n". ID and Type are single-line fields, so their line breaks are
// stripped. No payload can inject a field or end the event early.
func FormatEvent(e Event) string {
	var b strings.Builder
	if id := sseSingleLine(e.ID); id != "" {
		fmt.Fprintf(&b, "id: %s\n", id)
	}
	if typ := sseSingleLine(e.Type); typ != "" {
		fmt.Fprintf(&b, "event: %s\n", typ)
	}
	for _, line := range strings.Split(sseNormalizeNewlines(e.Data), "\n") {
		fmt.Fprintf(&b, "data: %s\n", line)
	}
	b.WriteString("\n")
	return b.String()
}

// sseNormalizeNewlines rewrites CRLF and bare CR as LF.
func sseNormalizeNewlines(s string) string {
	if !strings.ContainsRune(s, '\r') {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

// sseSingleLine removes every line terminator from a single-line SSE field.
func sseSingleLine(s string) string {
	if !strings.ContainsAny(s, "\r\n") {
		return s
	}
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}
