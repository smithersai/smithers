package email

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

// defaultSMTPIOTimeout bounds a whole SMTP session so a hung or tarpitting
// server cannot block a send goroutine forever.
const defaultSMTPIOTimeout = 30 * time.Second

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
	ioTimeout      time.Duration
}

// NewSMTPTransport creates a new SMTPTransport with the given config.
func NewSMTPTransport(cfg SMTPConfig) *SMTPTransport {
	return &SMTPTransport{
		cfg:         cfg,
		dialContext: (&net.Dialer{}).DialContext,
		dialTLSContext: func(ctx context.Context, network, addr string, config *tls.Config) (net.Conn, error) {
			return (&tls.Dialer{Config: config}).DialContext(ctx, network, addr)
		},
		ioTimeout: defaultSMTPIOTimeout,
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

// sessionDeadline is the earlier of the context deadline and the I/O timeout.
func (t *SMTPTransport) sessionDeadline(ctx context.Context) time.Time {
	deadline := time.Now().Add(t.ioTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	return deadline
}

func (t *SMTPTransport) connect(ctx context.Context, addr string) (smtpClient, error) {
	deadline := t.sessionDeadline(ctx)
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: t.cfg.Host,
	}

	if t.cfg.Port == 465 {
		conn, err := t.dialTLSContext(ctx, "tcp", addr, tlsConfig)
		if err != nil {
			return nil, fmt.Errorf("email: connect SMTPS %s: %w", addr, err)
		}
		if err := conn.SetDeadline(deadline); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("email: set SMTP deadline: %w", err)
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
	if err := conn.SetDeadline(deadline); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("email: set SMTP deadline: %w", err)
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

// buildMIMEMessage constructs an RFC 5322 message with Date and Message-ID
// headers, an RFC 2047 encoded subject, and quoted-printable parts so no line
// exceeds the 998-byte limit and 8-bit text survives 7-bit relays.
func buildMIMEMessage(from string, msg Message) []byte {
	var b strings.Builder
	boundary := "smithers-" + randomHex(16)

	from = sanitizeMIMEHeaderField(from)
	to := make([]string, len(msg.To))
	for i, recipient := range msg.To {
		to[i] = sanitizeMIMEHeaderField(recipient)
	}

	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", sanitizeMIMEHeaderField(msg.Subject)) + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("Message-ID: <" + randomHex(16) + "@" + messageIDDomain(from) + ">\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("X-Mailer: Smithers\r\n")

	if msg.Text != "" && msg.HTML != "" {
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
		b.WriteString("\r\n")
		b.WriteString("--" + boundary + "\r\n")
		writeMIMEPart(&b, "text/plain", msg.Text)
		b.WriteString("\r\n--" + boundary + "\r\n")
		writeMIMEPart(&b, "text/html", msg.HTML)
		b.WriteString("\r\n--" + boundary + "--\r\n")
	} else if msg.HTML != "" {
		writeMIMEPart(&b, "text/html", msg.HTML)
	} else {
		writeMIMEPart(&b, "text/plain", msg.Text)
	}

	return []byte(b.String())
}

func writeMIMEPart(b *strings.Builder, contentType, body string) {
	b.WriteString("Content-Type: " + contentType + "; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	var encoded bytes.Buffer
	w := quotedprintable.NewWriter(&encoded)
	_, _ = w.Write([]byte(body))
	_ = w.Close()
	b.WriteString(encoded.String())
}

func messageIDDomain(from string) string {
	if addr, err := mail.ParseAddress(from); err == nil {
		if at := strings.LastIndexByte(addr.Address, '@'); at >= 0 && at < len(addr.Address)-1 {
			return addr.Address[at+1:]
		}
	}
	return "smithers.invalid"
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func sanitizeMIMEHeaderField(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	return strings.ReplaceAll(s, "\n", "")
}
