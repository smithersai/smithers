package email

import (
	"log/slog"
)

// TransportConfig holds configuration for creating an email transport.
type TransportConfig struct {
	SMTP SMTPConfig
}

// NewTransport returns SMTP delivery when a host is configured and an
// accurately failing DisabledTransport otherwise.
func NewTransport(cfg TransportConfig) (Transport, error) {
	if cfg.SMTP.Host != "" {
		slog.Info("email transport configured", "provider", "smtp", "host", cfg.SMTP.Host, "port", cfg.SMTP.Port)
		return NewSMTPTransport(cfg.SMTP), nil
	}

	slog.Info("email delivery disabled")
	return &DisabledTransport{}, nil
}
