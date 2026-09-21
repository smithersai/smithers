package email

import (
	"fmt"
	"log/slog"
)

// TransportConfig holds configuration for creating an email transport.
type TransportConfig struct {
	SMTP     SMTPConfig
	SES      SESConfig
	SendGrid SendGridConfig
	// SESClient is required when SES is configured.
	SESClient SESAPI
}

// NewTransport creates an email Transport based on configuration precedence:
// 1. SendGrid (if API key is set)
// 2. SMTP (if Host is set)
// 3. SES (if Region is set)
// 4. Disabled (accurate failure when no provider is configured)
func NewTransport(cfg TransportConfig) (Transport, error) {
	if cfg.SendGrid.APIKey != "" {
		slog.Info("email transport configured", "provider", "sendgrid")
		return NewSendGridTransport(cfg.SendGrid)
	}

	if cfg.SMTP.Host != "" {
		slog.Info("email transport configured", "provider", "smtp", "host", cfg.SMTP.Host, "port", cfg.SMTP.Port)
		return NewSMTPTransport(cfg.SMTP), nil
	}

	if cfg.SES.Region != "" {
		if cfg.SESClient == nil {
			return nil, fmt.Errorf("email: SES region configured but SES client is nil")
		}
		slog.Info("email transport configured", "provider", "ses", "region", cfg.SES.Region)
		return NewSESTransport(cfg.SES, cfg.SESClient)
	}

	slog.Info("email delivery disabled")
	return &DisabledTransport{}, nil
}
