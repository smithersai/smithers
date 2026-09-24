package email

import (
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSMTPTransport_Send_HungServerTimesOut(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer func() { _ = conn.Close() }() // hold the connection open, never greet
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	tr := NewSMTPTransport(SMTPConfig{Host: "127.0.0.1", Port: port, From: "a@example.com"})
	tr.ioTimeout = 200 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		done <- tr.Send(context.Background(), Message{To: []string{"b@example.com"}, Subject: "s", Text: "t"})
	}()
	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("Send blocked on a server that never answers")
	}
}

func TestBuildMIMEMessage_IsRFC5322Compliant(t *testing.T) {
	t.Parallel()

	longLine := strings.Repeat("x", 1200)
	raw := buildMIMEMessage("Smithers <noreply@smithers.sh>", Message{
		To:      []string{"user@example.com"},
		Subject: "Verify your email address — Smithers",
		Text:    "héllo " + longLine,
		HTML:    "<p>héllo</p>",
	})
	for _, line := range strings.Split(string(raw), "\r\n") {
		require.LessOrEqual(t, len(line), 998)
	}

	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	require.NoError(t, err)
	_, err = msg.Header.Date()
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(msg.Header.Get("Message-ID"), "@smithers.sh>"))
	require.NotContains(t, msg.Header.Get("Subject"), "—", "raw non-ASCII subject")
	subject, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	require.NoError(t, err)
	require.Equal(t, "Verify your email address — Smithers", subject)

	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	require.NoError(t, err)
	require.Equal(t, "multipart/alternative", mediaType)
	reader := multipart.NewReader(msg.Body, params["boundary"])
	part, err := reader.NextPart()
	require.NoError(t, err)
	// multipart.Reader decodes quoted-printable parts and drops the header.
	require.Equal(t, 2, strings.Count(string(raw), "Content-Transfer-Encoding: quoted-printable\r\n"))
	body, err := io.ReadAll(part)
	require.NoError(t, err)
	require.Equal(t, "héllo "+longLine, string(body))

	other := buildMIMEMessage("noreply@smithers.sh", Message{To: []string{"u@example.com"}, Subject: "s", Text: "a", HTML: "b"})
	otherMsg, err := mail.ReadMessage(strings.NewReader(string(other)))
	require.NoError(t, err)
	_, otherParams, err := mime.ParseMediaType(otherMsg.Header.Get("Content-Type"))
	require.NoError(t, err)
	require.NotEqual(t, params["boundary"], otherParams["boundary"])
	require.NotEqual(t, msg.Header.Get("Message-ID"), otherMsg.Header.Get("Message-ID"))
}
