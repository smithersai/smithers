package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitSmartHTTP_Cov_BodyTrackingWriter(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	tracked := &bodyTrackingWriter{ResponseWriter: rec}
	assert.False(t, tracked.headersCommitted())

	tracked.WriteHeader(http.StatusAccepted)
	assert.True(t, tracked.headersCommitted())
	assert.Equal(t, http.StatusAccepted, rec.Code)

	rec = httptest.NewRecorder()
	tracked = &bodyTrackingWriter{ResponseWriter: rec}
	n, err := tracked.Write([]byte("pack"))
	require.NoError(t, err)
	assert.Equal(t, 4, n)
	assert.True(t, tracked.headersCommitted())
	assert.Equal(t, "pack", rec.Body.String())
}

func TestGitSmartHTTP_Cov_InfoRefsDefaultContentTypeAndErrors(t *testing.T) {
	t.Parallel()

	t.Run("default content type", func(t *testing.T) {
		t.Parallel()

		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(_ context.Context, _, _, _, _ string, stdout io.Writer) (string, error) {
				_, _ = io.WriteString(stdout, "refs")
				return " ", nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-receive-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec := httptest.NewRecorder()

		handler.InfoRefs(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "application/x-git-receive-pack-advertisement", rec.Header().Get("Content-Type"))
		assert.Equal(t, "refs", rec.Body.String())
	})

	t.Run("missing owner", func(t *testing.T) {
		t.Parallel()

		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/demo.git/info/refs?service=git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": " ", "repo": "demo.git"})
		rec := httptest.NewRecorder()

		handler.InfoRefs(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "owner is required")
	})

	t.Run("service unavailable", func(t *testing.T) {
		t.Parallel()

		handler := &GitSmartHandler{}
		req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec := httptest.NewRecorder()

		handler.InfoRefs(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestGitSmartHTTP_Cov_UploadAndReceiveCommittedError(t *testing.T) {
	t.Parallel()

	t.Run("upload error after body write does not corrupt stream", func(t *testing.T) {
		t.Parallel()

		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(_ context.Context, _, _, _ string, _ io.Reader, stdout io.Writer) error {
				_, _ = io.WriteString(stdout, "partial")
				return pkgerrors.Internal("late failure")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("want"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec := httptest.NewRecorder()

		handler.UploadPack(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "partial", rec.Body.String())
	})

	t.Run("receive error after body write does not corrupt stream", func(t *testing.T) {
		t.Parallel()

		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(_ context.Context, _, _, _ string, _ io.Reader, stdout io.Writer) error {
				_, _ = io.WriteString(stdout, "partial")
				return pkgerrors.Internal("late failure")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("push"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec := httptest.NewRecorder()

		handler.ReceivePack(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "partial", rec.Body.String())
	})
}
