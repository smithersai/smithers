package email

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/smtp"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSmtp_Cov_DefaultClosuresReturnErrors(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "127.0.0.1",
		Port: 465,
	})

	conn, err := tr.dialTLSContext(context.Background(), "tcp", "127.0.0.1:0", &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: "127.0.0.1",
	})
	require.Error(t, err)
	assert.Nil(t, conn)

	client, err := tr.newClient(&smtpCovConn{}, "smtp.example.com")
	require.Error(t, err)
	assert.Nil(t, client)
}

func TestSmtp_Cov_SendPropagatesClientError(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		User: "smithers",
		Pass: "secret",
		From: "noreply@smithers.sh",
	})
	client := &smtpCovClient{
		extensionOK: true,
		authErr:     errors.New("bad credentials"),
	}
	tr.dialContext = func(context.Context, string, string) (net.Conn, error) {
		return &smtpCovConn{}, nil
	}
	tr.newClient = func(net.Conn, string) (smtpClient, error) {
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "auth failure",
		Text:    "hello",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "email: SMTP auth failed")
	assert.True(t, client.closeCalled)
}

func TestSmtp_Cov_ConnectImplicitTLSDialError(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 465,
	})
	tr.dialTLSContext = func(context.Context, string, string, *tls.Config) (net.Conn, error) {
		return nil, errors.New("dial tls failed")
	}

	client, err := tr.connect(context.Background(), "smtp.example.com:465")

	require.Error(t, err)
	assert.Nil(t, client)
	assert.Contains(t, err.Error(), "email: connect SMTPS smtp.example.com:465")
	assert.Contains(t, err.Error(), "dial tls failed")
}

func TestSmtp_Cov_ConnectImplicitTLSNewClientErrorClosesConn(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 465,
	})
	conn := &smtpCovConn{}
	tr.dialTLSContext = func(context.Context, string, string, *tls.Config) (net.Conn, error) {
		return conn, nil
	}
	tr.newClient = func(net.Conn, string) (smtpClient, error) {
		return nil, errors.New("bad greeting")
	}

	client, err := tr.connect(context.Background(), "smtp.example.com:465")

	require.Error(t, err)
	assert.Nil(t, client)
	assert.Contains(t, err.Error(), "email: create SMTP client")
	assert.True(t, conn.closeCalled)
}

func TestSmtp_Cov_ConnectPlainNewClientErrorClosesConn(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
	})
	conn := &smtpCovConn{}
	tr.dialContext = func(context.Context, string, string) (net.Conn, error) {
		return conn, nil
	}
	tr.newClient = func(net.Conn, string) (smtpClient, error) {
		return nil, errors.New("bad greeting")
	}

	client, err := tr.connect(context.Background(), "smtp.example.com:587")

	require.Error(t, err)
	assert.Nil(t, client)
	assert.Contains(t, err.Error(), "email: create SMTP client")
	assert.True(t, conn.closeCalled)
}

func TestSmtp_Cov_ConnectStartTLSErrorClosesClient(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
	})
	client := &smtpCovClient{
		extensionOK: true,
		startTLSErr: errors.New("tls rejected"),
	}
	tr.dialContext = func(context.Context, string, string) (net.Conn, error) {
		return &smtpCovConn{}, nil
	}
	tr.newClient = func(net.Conn, string) (smtpClient, error) {
		return client, nil
	}

	connected, err := tr.connect(context.Background(), "smtp.example.com:587")

	require.Error(t, err)
	assert.Nil(t, connected)
	assert.Contains(t, err.Error(), "email: STARTTLS failed for smtp.example.com:587")
	assert.True(t, client.closeCalled)
}

func TestSmtp_Cov_SendWithClientCommandErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		client     *smtpCovClient
		wantErr    string
		assertions func(*testing.T, *smtpCovClient)
	}{
		{
			name:    "mail from",
			client:  &smtpCovClient{mailErr: errors.New("sender rejected")},
			wantErr: "email: MAIL FROM failed",
		},
		{
			name:    "recipient",
			client:  &smtpCovClient{rcptErr: errors.New("recipient rejected")},
			wantErr: `email: RCPT TO failed for "user@example.com"`,
		},
		{
			name:    "data",
			client:  &smtpCovClient{dataErr: errors.New("data unavailable")},
			wantErr: "email: DATA failed",
		},
		{
			name: "write",
			client: &smtpCovClient{
				dataWriter: &smtpCovWriter{writeErr: errors.New("write failed")},
			},
			wantErr: "email: write message",
			assertions: func(t *testing.T, client *smtpCovClient) {
				writer := client.dataWriter.(*smtpCovWriter)
				assert.True(t, writer.closeCalled)
			},
		},
		{
			name: "finalize",
			client: &smtpCovClient{
				dataWriter: &smtpCovWriter{closeErr: errors.New("close failed")},
			},
			wantErr: "email: finalize message",
		},
		{
			name:    "quit",
			client:  &smtpCovClient{quitErr: errors.New("quit failed")},
			wantErr: "email: QUIT failed",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			tr := NewSMTPTransport(SMTPConfig{Host: "smtp.example.com"})

			err := tr.sendWithClient(tt.client, "from@example.com", []string{"user@example.com"}, []byte("message"))

			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
			assert.True(t, tt.client.closeCalled)
			if tt.assertions != nil {
				tt.assertions(t, tt.client)
			}
		})
	}
}

func TestSmtp_Cov_BuildMIMEMessageAddsHeadersAndUnsubscribe(t *testing.T) {
	t.Parallel()

	raw := string(buildMIMEMessage("from@example.com", Message{
		To:             []string{"user@example.com"},
		Subject:        "headers",
		Text:           "hello",
		UnsubscribeURL: "https://smithers.sh/unsubscribe?token=abc",
		Headers: map[string]string{
			"X-Campaign-ID": "digest-42",
		},
	}))

	assert.Contains(t, raw, "List-Unsubscribe: <https://smithers.sh/unsubscribe?token=abc>\r\n")
	assert.Contains(t, raw, "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")
	assert.Contains(t, raw, "X-Campaign-ID: digest-42\r\n")
}

func TestSmtp_Cov_BuildMIMEMessageStripsHeaderNewlines(t *testing.T) {
	t.Parallel()

	raw := string(buildMIMEMessage("from@example.com\rBcc: from-injected@example.com", Message{
		To:             []string{"user@example.com\nBcc: to-injected@example.com"},
		Subject:        "digest\r\nBcc: subject-injected@example.com",
		Text:           "hello",
		UnsubscribeURL: "https://smithers.sh/unsubscribe?token=abc\nBcc: unsubscribe-injected@example.com",
		Headers: map[string]string{
			"X-Campaign-ID\rBcc": "digest-42\nBcc: header-injected@example.com",
		},
	}))

	assert.NotContains(t, raw, "\rBcc:")
	assert.NotContains(t, raw, "\nBcc:")
	assert.NotContains(t, raw, "\r\nBcc: from-injected@example.com")
	assert.NotContains(t, raw, "\r\nBcc: to-injected@example.com")
	assert.NotContains(t, raw, "\r\nBcc: subject-injected@example.com")
	assert.NotContains(t, raw, "\r\nBcc: unsubscribe-injected@example.com")
	assert.NotContains(t, raw, "\r\nBcc: header-injected@example.com")
	assert.Contains(t, raw, "From: from@example.comBcc: from-injected@example.com\r\n")
	assert.Contains(t, raw, "To: user@example.comBcc: to-injected@example.com\r\n")
	assert.Contains(t, raw, "Subject: digestBcc: subject-injected@example.com\r\n")
	assert.Contains(t, raw, "List-Unsubscribe: <https://smithers.sh/unsubscribe?token=abcBcc: unsubscribe-injected@example.com>\r\n")
	assert.Contains(t, raw, "X-Campaign-IDBcc: digest-42Bcc: header-injected@example.com\r\n")
}

type smtpCovClient struct {
	extensionOK    bool
	authErr        error
	mailErr        error
	rcptErr        error
	dataErr        error
	startTLSErr    error
	quitErr        error
	dataWriter     io.WriteCloser
	closeCalled    bool
	startTLSCalled bool
}

func (c *smtpCovClient) Auth(smtp.Auth) error {
	return c.authErr
}

func (c *smtpCovClient) Close() error {
	c.closeCalled = true
	return nil
}

func (c *smtpCovClient) Data() (io.WriteCloser, error) {
	if c.dataErr != nil {
		return nil, c.dataErr
	}
	if c.dataWriter == nil {
		c.dataWriter = &smtpCovWriter{}
	}
	return c.dataWriter, nil
}

func (c *smtpCovClient) Extension(ext string) (bool, string) {
	if ext != "STARTTLS" {
		return false, ""
	}
	return c.extensionOK, ""
}

func (c *smtpCovClient) Mail(string) error {
	return c.mailErr
}

func (c *smtpCovClient) Quit() error {
	return c.quitErr
}

func (c *smtpCovClient) Rcpt(string) error {
	return c.rcptErr
}

func (c *smtpCovClient) StartTLS(*tls.Config) error {
	c.startTLSCalled = true
	return c.startTLSErr
}

type smtpCovWriter struct {
	writeErr    error
	closeErr    error
	closeCalled bool
}

func (w *smtpCovWriter) Write(p []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return len(p), nil
}

func (w *smtpCovWriter) Close() error {
	w.closeCalled = true
	return w.closeErr
}

type smtpCovConn struct {
	closeCalled bool
}

func (c *smtpCovConn) Read([]byte) (int, error) {
	return 0, io.EOF
}

func (c *smtpCovConn) Write(p []byte) (int, error) {
	return len(p), nil
}

func (c *smtpCovConn) Close() error {
	c.closeCalled = true
	return nil
}

func (c *smtpCovConn) LocalAddr() net.Addr {
	return smtpCovAddr("local")
}

func (c *smtpCovConn) RemoteAddr() net.Addr {
	return smtpCovAddr("remote")
}

func (c *smtpCovConn) SetDeadline(time.Time) error {
	return nil
}

func (c *smtpCovConn) SetReadDeadline(time.Time) error {
	return nil
}

func (c *smtpCovConn) SetWriteDeadline(time.Time) error {
	return nil
}

type smtpCovAddr string

func (a smtpCovAddr) Network() string {
	return string(a)
}

func (a smtpCovAddr) String() string {
	return string(a)
}
