package routes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// lockedBuffer is a bytes.Buffer safe for a logger and a test reading it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// serveWithCapturedLog runs handler behind the real InjectLogger middleware
// and returns the response and everything the request logged.
func serveWithCapturedLog(t *testing.T, handler http.HandlerFunc, req *http.Request) (*httptest.ResponseRecorder, string) {
	t.Helper()
	logs := &lockedBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	rec := httptest.NewRecorder()
	middleware.InjectLogger(logger)(handler).ServeHTTP(rec, req)
	return rec, logs.String()
}

func TestGitSmartHTTP_5xxLogsTheCause(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
		proxyUploadPackFn: func(context.Context, string, string, string, io.Reader, io.Writer) error {
			return errors.New("dial repo-host: connection refused")
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(nil))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})

	rec, logs := serveWithCapturedLog(t, handler.UploadPack, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "connection refused")
	assert.Contains(t, logs, "connection refused")
	assert.Contains(t, logs, "/alice/demo.git/git-upload-pack")
}

func TestGitSmartHTTP_WrappedAPIErrorKeepsItsStatus(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
		proxyUploadPackFn: func(context.Context, string, string, string, io.Reader, io.Writer) error {
			return fmt.Errorf("authorize: %w", pkgerrors.Forbidden("permission denied"))
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(nil))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})

	rec, logs := serveWithCapturedLog(t, handler.UploadPack, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "permission denied\n", rec.Body.String())
	assert.NotContains(t, logs, "git smart HTTP request failed")
}

type failingCanaryLister struct{ err error }

func (f failingCanaryLister) ListCanaryResults(context.Context) ([]clusterdb.CanaryResult, error) {
	return nil, f.err
}

type failingGitHubAppReconciler struct{ err error }

func (f failingGitHubAppReconciler) ReconcileGitHubAppInstallations(context.Context) error {
	return f.err
}

// Each of these handlers once wrote Internal and dropped the error, so an
// operator saw a 500 with no dependency named.
func TestInternalErrorsLogTheirCause(t *testing.T) {
	t.Parallel()

	cause := errors.New("pool exhausted: sentinel-cause")
	cases := map[string]struct {
		handler http.HandlerFunc
		req     *http.Request
	}{
		"admin canaries": {
			(&AdminSystemCanariesHandler{Store: failingCanaryLister{cause}}).SystemCanaries,
			httptest.NewRequest(http.MethodGet, "/api/admin/system/canaries", nil),
		},
		"github app reconcile": {
			(&AdminGitHubAppHandler{Service: failingGitHubAppReconciler{cause}}).Reconcile,
			httptest.NewRequest(http.MethodPost, "/api/admin/github-app/reconcile", nil),
		},
		"anonymous sandbox": {
			func(w http.ResponseWriter, r *http.Request) { anonSandboxErr(w, r, cause) },
			httptest.NewRequest(http.MethodPost, "/api/public/sandboxes", nil),
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			rec, logs := serveWithCapturedLog(t, tc.handler, tc.req)
			require.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.NotContains(t, rec.Body.String(), "sentinel-cause")
			assert.Contains(t, logs, "sentinel-cause")
		})
	}
}

func TestGitHubAppReconcile_WrappedAPIErrorKeepsItsStatus(t *testing.T) {
	t.Parallel()

	h := &AdminGitHubAppHandler{Service: failingGitHubAppReconciler{fmt.Errorf("reconcile: %w", pkgerrors.Forbidden("app suspended"))}}
	rec, _ := serveWithCapturedLog(t, h.Reconcile, httptest.NewRequest(http.MethodPost, "/api/admin/github-app/reconcile", nil))

	require.Equal(t, http.StatusForbidden, rec.Code)
}

// A service that attaches its driver error with WithCause gets that error in
// the request log line, while the client still sees only the status text.
func TestWriteRouteError_LogsTheAttachedCause(t *testing.T) {
	t.Parallel()

	cause := errors.New("ERROR: canceling statement due to statement timeout (SQLSTATE 57014)")
	cases := map[string]error{
		"direct":  pkgerrors.Internal("failed to set secret").WithCause(cause),
		"wrapped": fmt.Errorf("authorize: %w", pkgerrors.Internal("failed to set secret").WithCause(cause)),
	}
	for name, routeErr := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodPut, "/api/secrets/x", nil)
			rec, logs := serveWithCapturedLog(t, func(w http.ResponseWriter, r *http.Request) {
				writeRouteError(w, r, routeErr)
			}, req)

			require.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.Contains(t, rec.Body.String(), "internal server error")
			assert.NotContains(t, rec.Body.String(), "SQLSTATE")
			assert.NotContains(t, rec.Body.String(), "failed to set secret")
			assert.Contains(t, logs, "SQLSTATE 57014")
			assert.Contains(t, logs, "failed to set secret")
			assert.Contains(t, logs, "code=internal")
		})
	}
}
