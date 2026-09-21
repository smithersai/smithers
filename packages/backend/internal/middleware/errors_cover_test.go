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

func TestErrors_Cov_BodySizeOverrideMatchingEdges(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodPut, "/api/repos/acme/widgets/file-drafts", nil)

	assert.False(t, bodySizeOverrideMatches(nil, BodySizeOverride{
		Method:      http.MethodPut,
		PathPattern: "/api/repos/{owner}/{repo}/file-drafts",
		Size:        64,
	}))
	assert.False(t, bodySizeOverrideMatches(req, BodySizeOverride{
		Method:      http.MethodPut,
		PathPattern: "/api/repos/{owner}/{repo}/file-drafts",
		Size:        0,
	}))
	assert.False(t, matchBodySizePathPattern("api/{owner}", "/api/acme"))
	assert.False(t, matchBodySizePathPattern("/api/{owner}/repo", "/api//repo"))
	assert.False(t, matchBodySizePathPattern("/api/repos", "/api/users"))
}
