package email

import (
	"context"
	"fmt"
)

// SESConfig holds AWS SES configuration.
type SESConfig struct {
	Region string
	From   string
}

// SESAPI is the minimal interface for the SES v2 client.
// This abstraction allows unit testing without the real AWS SDK.
type SESAPI interface {
	SendEmail(ctx context.Context, from string, to []string, subject, htmlBody, textBody string) error
}

// SESTransport sends email via AWS SES.
type SESTransport struct {
	cfg    SESConfig
	client SESAPI
}

// NewSESTransport creates a new SESTransport with the given config and SES client.
func NewSESTransport(cfg SESConfig, client SESAPI) (*SESTransport, error) {
	if cfg.Region == "" {
		return nil, fmt.Errorf("email: SES region is required")
	}
	if client == nil {
		return nil, fmt.Errorf("email: SES client is required")
	}
	return &SESTransport{cfg: cfg, client: client}, nil
}

// Send sends an email message via AWS SES.
func (t *SESTransport) Send(ctx context.Context, msg Message) error {
	if len(msg.To) == 0 {
		return fmt.Errorf("email: no recipients")
	}

	from := msg.From
	if from == "" {
		from = t.cfg.From
	}
	if from == "" {
		return fmt.Errorf("email: no from address configured")
	}

	return t.client.SendEmail(ctx, from, msg.To, msg.Subject, msg.HTML, msg.Text)
}
