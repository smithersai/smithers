package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestErrors_Cov_TimeoutWriterEdges(t *testing.T) {
	t.Parallel()

	tw := &timeoutWriter{w: httptest.NewRecorder(), hdr: make(http.Header)}
	assert.True(t, tw.markTimedOut())
	assert.False(t, tw.markTimedOut())

	tw = &timeoutWriter{w: httptest.NewRecorder(), hdr: make(http.Header)}
	conn, rw, err := tw.hijack()
	assert.Nil(t, conn)
	assert.Nil(t, rw)
	assert.ErrorIs(t, err, http.ErrNotSupported)
}
