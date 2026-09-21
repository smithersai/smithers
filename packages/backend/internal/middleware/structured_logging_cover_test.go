package middleware

import (
	"bufio"
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type structuredLoggingCovPlainWriter struct {
	header http.Header
}

func (w *structuredLoggingCovPlainWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *structuredLoggingCovPlainWriter) Write(p []byte) (int, error) {
	return len(p), nil
}

func (w *structuredLoggingCovPlainWriter) WriteHeader(int) {}

type structuredLoggingCovFlushWriter struct {
	structuredLoggingCovPlainWriter
	flushed bool
}

func (w *structuredLoggingCovFlushWriter) Flush() {
	w.flushed = true
}

type structuredLoggingCovHijackWriter struct {
	structuredLoggingCovPlainWriter
	hijacked bool
}

func (w *structuredLoggingCovHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	server, client := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

func TestStructuredLogging_Cov_HandlerSeverityAndGroupingEdges(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "ERROR", MapSeverity(slog.LevelError+4))

	var buf bytes.Buffer
	handler := NewGCPJSONHandler(&buf, nil)
	logger := slog.New(handler)
	logger.Info("nil level uses info")
	assert.Contains(t, buf.String(), `"severity":"INFO"`)

	grouped, ok := handler.WithGroup("request").(*gcpHandler)
	require.True(t, ok)
	assert.Equal(t, []string{"request"}, grouped.groups)
	assert.True(t, grouped.Enabled(context.Background(), slog.LevelInfo))
}

func TestStructuredLogging_Cov_ResponseWriterFlushAndHijack(t *testing.T) {
	t.Parallel()

	flusher := &structuredLoggingCovFlushWriter{}
	lrw := &loggingResponseWriter{ResponseWriter: flusher}
	lrw.Flush()
	assert.True(t, flusher.flushed)

	plain := &structuredLoggingCovPlainWriter{}
	lrw = &loggingResponseWriter{ResponseWriter: plain}
	assert.NotPanics(t, lrw.Flush)

	hijacker := &structuredLoggingCovHijackWriter{}
	hijackRec := &loggingHijacker{
		loggingResponseWriter: &loggingResponseWriter{ResponseWriter: hijacker},
		hijacker:              hijacker,
	}
	conn, rw, err := hijackRec.Hijack()
	require.NoError(t, err)
	require.NotNil(t, conn)
	require.NotNil(t, rw)
	assert.True(t, hijacker.hijacked)
	assert.NoError(t, conn.Close())
}

func TestStructuredLogging_Cov_FormatLatencyRounding(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "500ns", formatLatency(500*time.Nanosecond))
	assert.Equal(t, (2 * time.Microsecond).String(), formatLatency(1500*time.Nanosecond))
	assert.Equal(t, "2ms", formatLatency(1500*time.Microsecond))
	assert.Equal(t, "1.5s", formatLatency(1500*time.Millisecond))
}
