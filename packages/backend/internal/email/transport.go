package email

import (
	"context"
	"errors"
)

var ErrDeliveryNotConfigured = errors.New("email delivery is not configured")

// Message represents an outbound email.
type Message struct {
	From    string
	To      []string
	Subject string
	HTML    string
	Text    string
}

// Transport is the interface for sending email messages.
// Implementations include SMTPTransport and
// DisabledTransport. NoopTransport is a test recorder, not a production
// fallback.
type Transport interface {
	Send(ctx context.Context, msg Message) error
}

type transportAvailability interface {
	Available() bool
}

// DeliveryConfigured reports whether Send can reach a configured provider.
func DeliveryConfigured(transport Transport) bool {
	if transport == nil {
		return false
	}
	if availability, ok := transport.(transportAvailability); ok {
		return availability.Available()
	}
	return true
}

// DisabledTransport keeps optional email construction explicit. Calls fail
// accurately instead of being logged and reported as delivered.
type DisabledTransport struct{}

func (*DisabledTransport) Available() bool { return false }

func (*DisabledTransport) Send(context.Context, Message) error {
	return ErrDeliveryNotConfigured
}
