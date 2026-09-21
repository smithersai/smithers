package email

import (
	"context"
	"fmt"
	"strings"

	"github.com/sendgrid/sendgrid-go"
	"github.com/sendgrid/sendgrid-go/helpers/mail"
)

// SendGridConfig holds SendGrid API configuration.
type SendGridConfig struct {
	APIKey string
	From   string
}

// SendGridTransport sends email via the SendGrid v3 API.
type SendGridTransport struct {
	cfg    SendGridConfig
	client *sendgrid.Client
}

// NewSendGridTransport creates a new SendGridTransport with the given config.
func NewSendGridTransport(cfg SendGridConfig) (*SendGridTransport, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("email: SendGrid API key is required")
	}
	return &SendGridTransport{
		cfg:    cfg,
		client: sendgrid.NewSendClient(cfg.APIKey),
	}, nil
}

// Send sends an email message via the SendGrid v3 API.
func (t *SendGridTransport) Send(ctx context.Context, msg Message) error {
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

	sgMail := t.buildMessage(from, msg)

	resp, err := t.client.SendWithContext(ctx, sgMail)
	if err != nil {
		return fmt.Errorf("email: sendgrid request failed: %w", err)
	}

	if resp.StatusCode >= 400 {
		return fmt.Errorf("email: sendgrid returned %d: %s", resp.StatusCode, resp.Body)
	}

	return nil
}

// buildMessage translates our Message into a SendGrid mail.SGMailV3.
func (t *SendGridTransport) buildMessage(from string, msg Message) *mail.SGMailV3 {
	sgFrom := mail.NewEmail("", from)

	sgMail := mail.NewV3Mail()
	sgMail.SetFrom(sgFrom)
	sgMail.Subject = msg.Subject

	// Build personalization with all recipients.
	p := mail.NewPersonalization()
	for _, addr := range msg.To {
		p.AddTos(mail.NewEmail("", addr))
	}
	sgMail.AddPersonalizations(p)

	// Add content (text/plain first, then text/html per SendGrid convention).
	if msg.Text != "" {
		sgMail.AddContent(mail.NewContent("text/plain", msg.Text))
	}
	if msg.HTML != "" {
		sgMail.AddContent(mail.NewContent("text/html", msg.HTML))
	}
	if msg.Text == "" && msg.HTML == "" {
		sgMail.AddContent(mail.NewContent("text/plain", ""))
	}

	// Add List-Unsubscribe headers if present.
	if msg.UnsubscribeURL != "" {
		sgMail.SetHeader("List-Unsubscribe", "<"+msg.UnsubscribeURL+">")
		sgMail.SetHeader("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
	}

	// Add custom headers from the message.
	for k, v := range msg.Headers {
		// Don't overwrite List-Unsubscribe if already set.
		if msg.UnsubscribeURL != "" && (k == "List-Unsubscribe" || k == "List-Unsubscribe-Post") {
			continue
		}
		sgMail.SetHeader(k, v)
	}

	return sgMail
}

// ValidateSendGridRecipients checks that all recipient addresses have basic structure.
func ValidateSendGridRecipients(recipients []string) error {
	for _, to := range recipients {
		if !strings.Contains(to, "@") {
			return fmt.Errorf("email: invalid recipient %q", to)
		}
	}
	return nil
}
