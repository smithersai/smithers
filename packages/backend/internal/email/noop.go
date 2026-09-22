package email

import (
	"context"
	"log/slog"
)

// NoopTransport records email messages for tests. NewTransport never selects
// it as a production fallback; unconfigured delivery uses DisabledTransport.
type NoopTransport struct {
	// Sent captures messages for test assertions. Not thread-safe — use only in tests.
	Sent []Message
}

// Send records the email details and returns nil.
func (t *NoopTransport) Send(_ context.Context, msg Message) error {
	slog.Info("email noop transport captured message", "to", msg.To, "subject", msg.Subject)
	t.Sent = append(t.Sent, msg)
	return nil
}
