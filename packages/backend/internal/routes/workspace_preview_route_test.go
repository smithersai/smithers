package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type previewRouteService struct {
	mockWorkspaceRouteService
	access services.WorkspacePreviewAccess
	err    error
	port   uint16
}

func (s *previewRouteService) ResolveWorkspacePreview(_ context.Context, _ string, _, _ int64, port uint16, _ string) (services.WorkspacePreviewAccess, error) {
	s.port = port
	return s.access, s.err
}

func previewRequest(t *testing.T, port, rest string) *http.Request {
	t.Helper()
	path := "/api/repos/alice/demo/workspaces/ws1/preview/" + port + "/" + rest
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = withAuth(req, 1, "alice")
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	return withRouteParams(req, map[string]string{"id": "ws1", "port": port, "*": rest})
}

// Every refused target points at a live upstream, so a regression that let
// one through would reach it; the refusal must happen before any dial.
func TestProxyWorkspacePreview_RefusesNonLoopbackTargets(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	port := strings.TrimPrefix(upstream.URL, "http://127.0.0.1:")

	for name, target := range map[string]string{
		"unspecified address": "http://0.0.0.0:" + port,
		"port mismatch":       "http://127.0.0.1:" + port,
		"userinfo":            "http://user:pass@127.0.0.1:" + port,
		"path on target":      "http://127.0.0.1:" + port + "/admin",
		"query on target":     "http://127.0.0.1:" + port + "/?x=1",
		"fragment":            "http://127.0.0.1:" + port + "/#top",
		"https scheme":        "https://127.0.0.1:" + port,
		"unparseable":         "http://[::1",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			routePort := port
			if name == "port mismatch" {
				routePort = "1"
			}
			h := &WorkspaceHandler{Service: &previewRouteService{access: services.WorkspacePreviewAccess{URL: target, Proxy: true}}}
			rec := httptest.NewRecorder()
			h.ProxyWorkspacePreview(rec, previewRequest(t, routePort, ""))
			assert.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
		})
	}
	t.Cleanup(func() { assert.Zero(t, hits.Load(), "a refused preview target was dialed") })
}

func TestProxyWorkspacePreview_RejectsBadPorts(t *testing.T) {
	t.Parallel()

	for _, port := range []string{"0", "65536", "abc", "-1"} {
		h := &WorkspaceHandler{Service: &previewRouteService{}}
		rec := httptest.NewRecorder()
		h.ProxyWorkspacePreview(rec, previewRequest(t, port, ""))
		assert.Equal(t, http.StatusBadRequest, rec.Code, port)
	}
}

func TestProxyWorkspacePreview_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &previewRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws1/preview/4317/", nil)
	req = withRouteParams(withWorkspaceRepoCtx(req, "alice", "demo"), map[string]string{"id": "ws1", "port": "4317"})
	rec := httptest.NewRecorder()
	h.ProxyWorkspacePreview(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestProxyWorkspacePreview_HostedAdapterRedirects(t *testing.T) {
	t.Parallel()

	svc := &previewRouteService{access: services.WorkspacePreviewAccess{URL: "https://preview.example/ws1", Proxy: false}}
	h := &WorkspaceHandler{Service: svc}
	rec := httptest.NewRecorder()
	h.ProxyWorkspacePreview(rec, previewRequest(t, "4317", ""))
	assert.Equal(t, http.StatusTemporaryRedirect, rec.Code)
	assert.Equal(t, "https://preview.example/ws1", rec.Header().Get("Location"))
	assert.EqualValues(t, 4317, svc.port)
}

func TestProxyWorkspacePreview_ServiceWithoutPreviewIsUnavailable(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
	rec := httptest.NewRecorder()
	h.ProxyWorkspacePreview(rec, previewRequest(t, "4317", ""))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

// The proxied page runs repository code on the product origin, so the proxy
// must strip product credentials on the way in and sandbox the page on the
// way out.
func TestProxyWorkspacePreview_EndToEndStripsCredentialsAndSandboxes(t *testing.T) {
	t.Parallel()

	received := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Clone(context.Background())
		http.SetCookie(w, &http.Cookie{Name: "smithers_session", Value: "forged"})
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<script>fetch('/api/user/tokens',{method:'POST'})</script>")
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	require.NoError(t, err)

	h := &WorkspaceHandler{Service: &previewRouteService{access: services.WorkspacePreviewAccess{URL: upstream.URL, Proxy: true}}}
	req := previewRequest(t, target.Port(), "app/index.html")
	for _, header := range workspacePreviewCredentialHeaders {
		req.Header.Set(header, "secret")
	}
	req.Header.Set("Forwarded", "for=attacker")
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	req.Header.Set("X-Forwarded-Host", "attacker.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()

	h.ProxyWorkspacePreview(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	got := <-received
	assert.Equal(t, "/app/index.html", got.URL.Path)
	assert.Equal(t, target.Host, got.Host)
	for _, header := range workspacePreviewCredentialHeaders {
		assert.Empty(t, got.Header.Get(header), header)
	}
	assert.Empty(t, got.Header.Get("Forwarded"))
	assert.NotContains(t, got.Header.Get("X-Forwarded-For"), "6.6.6.6")
	assert.Empty(t, got.Header.Get("X-Forwarded-Host"))
	assert.Empty(t, got.Header.Get("X-Forwarded-Proto"))
	assert.Equal(t, "/api/repos/alice/demo/workspaces/ws1/preview/"+target.Port(), got.Header.Get("X-Forwarded-Prefix"))

	assert.Empty(t, rec.Header().Values("Set-Cookie"))
	csp := rec.Header().Values("Content-Security-Policy")
	require.NotEmpty(t, csp)
	assert.Contains(t, csp, workspacePreviewSandboxPolicy)
	assert.True(t, strings.HasPrefix(workspacePreviewSandboxPolicy, "sandbox "))
	assert.NotContains(t, workspacePreviewSandboxPolicy, "allow-same-origin")
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

// The route port is compared by value, so a zero-padded port that resolves to
// the same loopback target is proxied instead of refused.
func TestProxyWorkspacePreview_ZeroPaddedPortMatchesTarget(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	require.NoError(t, err)

	svc := &previewRouteService{access: services.WorkspacePreviewAccess{URL: upstream.URL, Proxy: true}}
	h := &WorkspaceHandler{Service: svc}
	rec := httptest.NewRecorder()
	h.ProxyWorkspacePreview(rec, previewRequest(t, "0"+target.Port(), ""))

	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, target.Port(), strconv.FormatUint(uint64(svc.port), 10))
}
