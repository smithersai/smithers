package email

import (
	"context"
	"log/slog"
)

// NoopTransport logs email messages without actually sending them.
// Used in development and test environments when no SMTP/SES is configured.
type NoopTransport struct {
	// Sent captures messages for test assertions. Not thread-safe — use only in tests.
	Sent []Message
}

// Send logs the email details and returns nil (always succeeds).
func (t *NoopTransport) Send(_ context.Context, msg Message) error {
	slog.Info("email noop transport captured message", "to", msg.To, "subject", msg.Subject)
	t.Sent = append(t.Sent, msg)
	return nil
}
