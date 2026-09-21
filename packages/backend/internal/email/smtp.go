package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"strings"
)

// SMTPConfig holds SMTP server connection details.
type SMTPConfig struct {
	Host string
	Port int
	User string
	Pass string
	From string
}

// SMTPTransport sends email via SMTP using Go's net/smtp package.
type SMTPTransport struct {
	cfg            SMTPConfig
	dialContext    func(ctx context.Context, network, addr string) (net.Conn, error)
	dialTLSContext func(ctx context.Context, network, addr string, config *tls.Config) (net.Conn, error)
	newClient      func(conn net.Conn, host string) (smtpClient, error)
}

// NewSMTPTransport creates a new SMTPTransport with the given config.
func NewSMTPTransport(cfg SMTPConfig) *SMTPTransport {
	return &SMTPTransport{
		cfg:         cfg,
		dialContext: (&net.Dialer{}).DialContext,
		dialTLSContext: func(ctx context.Context, network, addr string, config *tls.Config) (net.Conn, error) {
			return tls.DialWithDialer(&net.Dialer{}, network, addr, config)
		},
		newClient: func(conn net.Conn, host string) (smtpClient, error) {
			return smtp.NewClient(conn, host)
		},
	}
}

// Send sends an email message via SMTP.
func (t *SMTPTransport) Send(ctx context.Context, msg Message) error {
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

	for _, to := range msg.To {
		if !strings.Contains(to, "@") {
			return fmt.Errorf("email: invalid recipient %q", to)
		}
	}

	addr := fmt.Sprintf("%s:%d", t.cfg.Host, t.cfg.Port)
	mimeMsg := buildMIMEMessage(from, msg)
	client, err := t.connect(ctx, addr)
	if err != nil {
		return err
	}

	if err := t.sendWithClient(client, from, msg.To, mimeMsg); err != nil {
		return err
	}

	return nil
}

type smtpClient interface {
	Auth(auth smtp.Auth) error
	Close() error
	Data() (io.WriteCloser, error)
	Extension(ext string) (bool, string)
	Mail(from string) error
	Quit() error
	Rcpt(to string) error
	StartTLS(config *tls.Config) error
}

func (t *SMTPTransport) connect(ctx context.Context, addr string) (smtpClient, error) {
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: t.cfg.Host,
	}

	if t.cfg.Port == 465 {
		conn, err := t.dialTLSContext(ctx, "tcp", addr, tlsConfig)
		if err != nil {
			return nil, fmt.Errorf("email: connect SMTPS %s: %w", addr, err)
		}
		client, err := t.newClient(conn, t.cfg.Host)
		if err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("email: create SMTP client: %w", err)
		}
		return client, nil
	}

	conn, err := t.dialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("email: connect SMTP %s: %w", addr, err)
	}

	client, err := t.newClient(conn, t.cfg.Host)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("email: create SMTP client: %w", err)
	}

	ok, _ := client.Extension("STARTTLS")
	if !ok {
		_ = client.Close()
		return nil, fmt.Errorf("email: server %s does not support STARTTLS", addr)
	}
	if err := client.StartTLS(tlsConfig); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("email: STARTTLS failed for %s: %w", addr, err)
	}

	return client, nil
}

func (t *SMTPTransport) sendWithClient(client smtpClient, from string, to []string, mimeMsg []byte) error {
	closeClient := true
	defer func() {
		if closeClient {
			_ = client.Close()
		}
	}()

	if t.cfg.User != "" {
		auth := smtp.PlainAuth("", t.cfg.User, t.cfg.Pass, t.cfg.Host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("email: SMTP auth failed: %w", err)
		}
	}

	if err := client.Mail(from); err != nil {
		return fmt.Errorf("email: MAIL FROM failed: %w", err)
	}
	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			return fmt.Errorf("email: RCPT TO failed for %q: %w", recipient, err)
		}
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("email: DATA failed: %w", err)
	}
	if _, err := w.Write(mimeMsg); err != nil {
		_ = w.Close()
		return fmt.Errorf("email: write message: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("email: finalize message: %w", err)
	}

	if err := client.Quit(); err != nil {
		return fmt.Errorf("email: QUIT failed: %w", err)
	}
	closeClient = false
	return nil
}

// buildMIMEMessage constructs a multipart MIME email with both HTML and plain text.
func buildMIMEMessage(from string, msg Message) []byte {
	var b strings.Builder
	boundary := "==SmithersEmailBoundary=="

	from = sanitizeMIMEHeaderField(from)
	to := make([]string, len(msg.To))
	for i, recipient := range msg.To {
		to[i] = sanitizeMIMEHeaderField(recipient)
	}

	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	b.WriteString("Subject: " + sanitizeMIMEHeaderField(msg.Subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("X-Mailer: Smithers\r\n")

	// RFC 8058: List-Unsubscribe and one-click unsubscribe.
	if msg.UnsubscribeURL != "" {
		b.WriteString("List-Unsubscribe: <" + sanitizeMIMEHeaderField(msg.UnsubscribeURL) + ">\r\n")
		b.WriteString("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")
	}

	// Additional custom headers.
	for k, v := range msg.Headers {
		b.WriteString(sanitizeMIMEHeaderField(k) + ": " + sanitizeMIMEHeaderField(v) + "\r\n")
	}

	if msg.Text != "" && msg.HTML != "" {
		// Multipart message
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
		b.WriteString("\r\n")
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		b.WriteString("\r\n")
		b.WriteString(msg.Text)
		b.WriteString("\r\n")
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
		b.WriteString("\r\n")
		b.WriteString(msg.HTML)
		b.WriteString("\r\n")
		b.WriteString("--" + boundary + "--\r\n")
	} else if msg.HTML != "" {
		b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
		b.WriteString("\r\n")
		b.WriteString(msg.HTML)
	} else {
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		b.WriteString("\r\n")
		b.WriteString(msg.Text)
	}

	return []byte(b.String())
}

func sanitizeMIMEHeaderField(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	return strings.ReplaceAll(s, "\n", "")
}
