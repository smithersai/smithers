package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitSmartHTTP_H_InfoUploadReceiveErrors(t *testing.T) {
	t.Run("info refs repo and service errors", func(t *testing.T) {
		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/alice/demo/info/refs?service=git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		handler.InfoRefs(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = &mockGitSmartRouteService{
			proxyInfoRefsFn: func(context.Context, string, string, string, string, io.Writer) (string, error) {
				return "", pkgerrors.NotFound("repo missing")
			},
		}
		req = httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		handler.InfoRefs(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("upload early errors", func(t *testing.T) {
		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/demo.git/git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": " ", "repo": "demo.git"})
		rec := httptest.NewRecorder()
		handler.UploadPack(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/alice/demo/git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.UploadPack(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		(&GitSmartHandler{}).UploadPack(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		handler.Service = &mockGitSmartRouteService{
			proxyUploadPackFn: func(context.Context, string, string, string, io.Reader, io.Writer) error {
				return pkgerrors.Forbidden("denied")
			},
		}
		req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("want"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		handler.UploadPack(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("receive early errors", func(t *testing.T) {
		handler := &GitSmartHandler{Service: &mockGitSmartRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/demo.git/git-receive-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": " ", "repo": "demo.git"})
		rec := httptest.NewRecorder()
		handler.ReceivePack(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/alice/demo/git-receive-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec = httptest.NewRecorder()
		handler.ReceivePack(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		(&GitSmartHandler{}).ReceivePack(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("not gzip"))
		req.Header.Set("Content-Encoding", "gzip")
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		handler.ReceivePack(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		handler.Service = &mockGitSmartRouteService{
			proxyReceivePackFn: func(context.Context, string, string, string, io.Reader, io.Writer) error {
				return pkgerrors.Forbidden("denied")
			},
		}
		req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("push"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
		rec = httptest.NewRecorder()
		handler.ReceivePack(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}
