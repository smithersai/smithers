package email

import "context"

// Message represents an outbound email.
type Message struct {
	From    string
	To      []string
	Subject string
	HTML    string
	Text    string
	// UnsubscribeURL is the one-click unsubscribe URL. When set, transports
	// should include List-Unsubscribe and List-Unsubscribe-Post headers (RFC 8058).
	UnsubscribeURL string
	// Headers holds additional custom headers to include in the email.
	Headers map[string]string
}

// Transport is the interface for sending email messages.
// Implementations include SMTPTransport, SESTransport, and NoopTransport.
type Transport interface {
	Send(ctx context.Context, msg Message) error
}
