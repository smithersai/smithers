package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSMTPTransport_Send_UsesConfiguredHostAndAuth(t *testing.T) {
	t.Parallel()

	var dialedAddr string
	var dialedNetwork string
	var startTLSConfig *tls.Config
	var capturedAddr string
	var capturedFrom string
	var capturedTo []string
	var capturedMsg []byte

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		User: "smithers",
		Pass: "secret",
		From: "noreply@smithers.sh",
	})
	client := &fakeSMTPClient{
		extensions: map[string]bool{"STARTTLS": true},
		dataWriter: &captureWriteCloser{onClose: func(b []byte) {
			capturedMsg = append([]byte(nil), b...)
		}},
	}
	tr.dialContext = func(_ context.Context, network, addr string) (net.Conn, error) {
		dialedNetwork = network
		dialedAddr = addr
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, host string) (smtpClient, error) {
		capturedAddr = host
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test Subject",
		HTML:    "<p>Hello</p>",
		Text:    "Hello",
	})

	require.NoError(t, err)
	assert.Equal(t, "tcp", dialedNetwork)
	assert.Equal(t, "smtp.example.com:587", dialedAddr)
	require.NotNil(t, client.startTLSConfig)
	startTLSConfig = client.startTLSConfig
	assert.EqualValues(t, tls.VersionTLS12, startTLSConfig.MinVersion)
	assert.Equal(t, "smtp.example.com", startTLSConfig.ServerName)
	assert.Equal(t, "smtp.example.com", capturedAddr)
	capturedFrom = client.mailFrom
	capturedTo = append([]string(nil), client.rcptTo...)
	assert.Equal(t, "noreply@smithers.sh", capturedFrom)
	assert.Equal(t, []string{"user@example.com"}, capturedTo)
	assert.Contains(t, string(capturedMsg), "Subject: Test Subject")
	assert.Contains(t, string(capturedMsg), "X-Mailer: Smithers")
	assert.True(t, client.authCalled)
	assert.Equal(t, "noreply@smithers.sh", client.mailFrom)
	assert.Equal(t, []string{"user@example.com"}, client.rcptTo)
	assert.True(t, client.quitCalled)
}

func TestSMTPTransport_Send_ValidatesRecipient(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "noreply@smithers.sh",
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"invalid-no-at-sign"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid recipient")
}

func TestSMTPTransport_Send_NoRecipients(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "noreply@smithers.sh",
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no recipients")
}

func TestSMTPTransport_Send_NoFromAddress(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
	})

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no from address")
}

func TestSMTPTransport_Send_MessageFromOverridesConfig(t *testing.T) {
	t.Parallel()

	var capturedFrom string

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "default@smithers.sh",
	})
	client := &fakeSMTPClient{
		extensions: map[string]bool{"STARTTLS": true},
		dataWriter: &captureWriteCloser{},
	}
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, _ string) (smtpClient, error) {
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		From:    "override@smithers.sh",
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.NoError(t, err)
	capturedFrom = client.mailFrom
	assert.Equal(t, "override@smithers.sh", capturedFrom)
}

func TestSMTPTransport_Send_DialError(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "noreply@smithers.sh",
	})
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		return nil, fmt.Errorf("connection refused")
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "connection refused")
}

func TestSMTPTransport_Send_RequiresSTARTTLS(t *testing.T) {
	t.Parallel()

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "noreply@smithers.sh",
	})
	client := &fakeSMTPClient{
		extensions: map[string]bool{},
	}
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, _ string) (smtpClient, error) {
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "does not support STARTTLS")
	assert.True(t, client.closeCalled)
	assert.False(t, client.startTLSCalled)
}

func TestSMTPTransport_Send_MultipartMIME(t *testing.T) {
	t.Parallel()

	var capturedMsg string

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 587,
		From: "noreply@smithers.sh",
	})
	client := &fakeSMTPClient{
		extensions: map[string]bool{"STARTTLS": true},
		dataWriter: &captureWriteCloser{onClose: func(b []byte) {
			capturedMsg = string(b)
		}},
	}
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, _ string) (smtpClient, error) {
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Multi",
		HTML:    "<p>HTML</p>",
		Text:    "Plain text",
	})

	require.NoError(t, err)
	assert.Contains(t, capturedMsg, "multipart/alternative")
	assert.Contains(t, capturedMsg, "text/plain")
	assert.Contains(t, capturedMsg, "text/html")
	assert.Contains(t, capturedMsg, "Plain text")
	assert.Contains(t, capturedMsg, "<p>HTML</p>")
}

func TestSMTPTransport_Send_NoAuthWhenNoUser(t *testing.T) {
	t.Parallel()

	sendCalled := false
	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 25,
		From: "noreply@smithers.sh",
		// No User/Pass set
	})
	client := &fakeSMTPClient{
		extensions: map[string]bool{"STARTTLS": true},
		dataWriter: &captureWriteCloser{},
		onAuth: func(auth smtp.Auth) error {
			assert.Fail(t, "auth should not be called")
			return nil
		},
	}
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, _ string) (smtpClient, error) {
		sendCalled = true
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.NoError(t, err)
	assert.True(t, sendCalled)
	assert.False(t, client.authCalled)
}

func TestSMTPTransport_Send_UsesImplicitTLSOnPort465(t *testing.T) {
	t.Parallel()

	var tlsAddr string
	var tlsNetwork string
	var tlsConfig *tls.Config

	tr := NewSMTPTransport(SMTPConfig{
		Host: "smtp.example.com",
		Port: 465,
		User: "smithers",
		Pass: "secret",
		From: "noreply@smithers.sh",
	})
	client := &fakeSMTPClient{
		dataWriter: &captureWriteCloser{},
	}
	tr.dialContext = func(_ context.Context, _, _ string) (net.Conn, error) {
		t.Fatal("plain dial should not be used for SMTPS")
		return nil, nil
	}
	tr.dialTLSContext = func(_ context.Context, network, addr string, config *tls.Config) (net.Conn, error) {
		tlsNetwork = network
		tlsAddr = addr
		tlsConfig = config
		return &fakeConn{}, nil
	}
	tr.newClient = func(_ net.Conn, _ string) (smtpClient, error) {
		return client, nil
	}

	err := tr.Send(context.Background(), Message{
		To:      []string{"user@example.com"},
		Subject: "Test",
		Text:    "Hello",
	})

	require.NoError(t, err)
	assert.Equal(t, "tcp", tlsNetwork)
	assert.Equal(t, "smtp.example.com:465", tlsAddr)
	require.NotNil(t, tlsConfig)
	assert.EqualValues(t, tls.VersionTLS12, tlsConfig.MinVersion)
	assert.Equal(t, "smtp.example.com", tlsConfig.ServerName)
	assert.False(t, client.startTLSCalled)
	assert.True(t, client.authCalled)
}

func TestBuildMIMEMessage_HTMLOnly(t *testing.T) {
	t.Parallel()
	msg := buildMIMEMessage("from@test.com", Message{
		To:      []string{"to@test.com"},
		Subject: "HTML Only",
		HTML:    "<h1>Hello</h1>",
	})
	s := string(msg)
	assert.Contains(t, s, "Content-Type: text/html")
	assert.NotContains(t, s, "multipart")
}

func TestBuildMIMEMessage_TextOnly(t *testing.T) {
	t.Parallel()
	msg := buildMIMEMessage("from@test.com", Message{
		To:      []string{"to@test.com"},
		Subject: "Text Only",
		Text:    "Hello",
	})
	s := string(msg)
	assert.Contains(t, s, "Content-Type: text/plain")
	assert.NotContains(t, s, "multipart")
}

func TestBuildMIMEMessage_MultipleRecipients(t *testing.T) {
	t.Parallel()
	msg := buildMIMEMessage("from@test.com", Message{
		To:      []string{"a@test.com", "b@test.com"},
		Subject: "Multi",
		Text:    "Hello",
	})
	s := string(msg)
	assert.True(t, strings.Contains(s, "a@test.com") && strings.Contains(s, "b@test.com"))
}

type fakeSMTPClient struct {
	extensions     map[string]bool
	startTLSCalled bool
	startTLSConfig *tls.Config
	authCalled     bool
	mailFrom       string
	rcptTo         []string
	dataWriter     io.WriteCloser
	quitCalled     bool
	closeCalled    bool
	onAuth         func(auth smtp.Auth) error
}

func (f *fakeSMTPClient) Auth(auth smtp.Auth) error {
	f.authCalled = true
	if f.onAuth != nil {
		return f.onAuth(auth)
	}
	return nil
}

func (f *fakeSMTPClient) Close() error {
	f.closeCalled = true
	return nil
}

func (f *fakeSMTPClient) Data() (io.WriteCloser, error) {
	if f.dataWriter == nil {
		f.dataWriter = &captureWriteCloser{}
	}
	return f.dataWriter, nil
}

func (f *fakeSMTPClient) Extension(ext string) (bool, string) {
	return f.extensions[ext], ""
}

func (f *fakeSMTPClient) Mail(from string) error {
	f.mailFrom = from
	return nil
}

func (f *fakeSMTPClient) Quit() error {
	f.quitCalled = true
	return nil
}

func (f *fakeSMTPClient) Rcpt(to string) error {
	f.rcptTo = append(f.rcptTo, to)
	return nil
}

func (f *fakeSMTPClient) StartTLS(config *tls.Config) error {
	f.startTLSCalled = true
	f.startTLSConfig = config
	return nil
}

type captureWriteCloser struct {
	buf     []byte
	onClose func([]byte)
}

func (c *captureWriteCloser) Write(p []byte) (int, error) {
	c.buf = append(c.buf, p...)
	return len(p), nil
}

func (c *captureWriteCloser) Close() error {
	if c.onClose != nil {
		c.onClose(c.buf)
	}
	return nil
}

type fakeConn struct{}

func (f *fakeConn) Read(_ []byte) (int, error)         { return 0, io.EOF }
func (f *fakeConn) Write(b []byte) (int, error)        { return len(b), nil }
func (f *fakeConn) Close() error                       { return nil }
func (f *fakeConn) LocalAddr() net.Addr                { return fakeAddr("local") }
func (f *fakeConn) RemoteAddr() net.Addr               { return fakeAddr("remote") }
func (f *fakeConn) SetDeadline(_ time.Time) error      { return nil }
func (f *fakeConn) SetReadDeadline(_ time.Time) error  { return nil }
func (f *fakeConn) SetWriteDeadline(_ time.Time) error { return nil }

type fakeAddr string

func (f fakeAddr) Network() string { return string(f) }
func (f fakeAddr) String() string  { return string(f) }
