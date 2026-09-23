package email

import (
	"context"
	"errors"
)

// NewSESClient is intentionally unavailable in the public process.
func NewSESClient(context.Context, string) (SESAPI, error) {
	return nil, errors.New("AWS SES is unavailable in the public backend")
}

// SendGridConfig remains a private-deployment input shape; the public backend
// does not construct a SendGrid client.
type SendGridConfig struct {
	APIKey string
	From   string
}

type SendGridTransport struct{}

func NewSendGridTransport(SendGridConfig) (*SendGridTransport, error) {
	return nil, errors.New("SendGrid is unavailable in the public backend")
}
func (*SendGridTransport) Send(context.Context, Message) error {
	return ErrDeliveryNotConfigured
}
