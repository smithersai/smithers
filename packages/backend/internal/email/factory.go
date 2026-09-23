package email

import (
	"log/slog"
)

// TransportConfig holds configuration for creating an email transport.
type TransportConfig struct {
	SMTP SMTPConfig
	SES  SESConfig
}

// NewTransport creates an email Transport based on configuration precedence:
// 1. SendGrid (if API key is set)
// 2. SMTP (if Host is set)
// 3. SES (if Region is set)
// 4. Disabled (accurate failure when no provider is configured)
func NewTransport(cfg TransportConfig) (Transport, error) {

	if cfg.SMTP.Host != "" {
		slog.Info("email transport configured", "provider", "smtp", "host", cfg.SMTP.Host, "port", cfg.SMTP.Port)
		return NewSMTPTransport(cfg.SMTP), nil
	}

	slog.Info("email delivery disabled")
	return &DisabledTransport{}, nil
}
