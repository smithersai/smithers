// Package sse provides utilities for Server-Sent Events backed by PostgreSQL LISTEN/NOTIFY.
package sse

import (
	"context"
	"fmt"
	"strings"

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

// brokerNotifier adapts one shared PostgreSQL connection for fan-out.
type brokerNotifier interface {
	// waitForNotificationWithChannel blocks until a NOTIFY arrives and returns both channel and payload.
	waitForNotificationWithChannel(ctx context.Context) (channel string, payload string, err error)
	// release returns the underlying connection to the pool.
	release()
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
func discardNotifier(n brokerNotifier) {
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
