package middleware

import (
	"bufio"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type metricsCovPlainWriter struct {
	header http.Header
}

func (w *metricsCovPlainWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *metricsCovPlainWriter) Write(p []byte) (int, error) {
	return len(p), nil
}

func (w *metricsCovPlainWriter) WriteHeader(int) {}

type metricsCovFlushWriter struct {
	metricsCovPlainWriter
	flushed bool
}

func (w *metricsCovFlushWriter) Flush() {
	w.flushed = true
}

type metricsCovHijackWriter struct {
	metricsCovPlainWriter
	hijacked bool
}

func (w *metricsCovHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	server, client := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

func TestMetrics_Cov_StatusRecorderFlushAndHijack(t *testing.T) {
	t.Parallel()

	flusher := &metricsCovFlushWriter{}
	rec := &statusRecorder{ResponseWriter: flusher, status: http.StatusOK}
	rec.Flush()
	assert.True(t, flusher.flushed)

	plain := &metricsCovPlainWriter{}
	rec = &statusRecorder{ResponseWriter: plain, status: http.StatusOK}
	assert.NotPanics(t, rec.Flush)

	hijacker := &metricsCovHijackWriter{}
	hijackRec := &hijackStatusRecorder{
		statusRecorder: &statusRecorder{ResponseWriter: hijacker, status: http.StatusOK},
		hijacker:       hijacker,
	}

	conn, rw, err := hijackRec.Hijack()
	require.NoError(t, err)
	require.NotNil(t, conn)
	require.NotNil(t, rw)
	assert.True(t, hijacker.hijacked)
	assert.NoError(t, conn.Close())
}
