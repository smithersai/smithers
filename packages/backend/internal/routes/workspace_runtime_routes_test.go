package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

type countingRuntimeTerminal struct{ closes atomic.Int32 }

func (*countingRuntimeTerminal) Read([]byte) (int, error)        { return 0, io.EOF }
func (*countingRuntimeTerminal) Write(value []byte) (int, error) { return len(value), nil }
func (t *countingRuntimeTerminal) Close() error {
	t.closes.Add(1)
	return nil
}
func (*countingRuntimeTerminal) Resize(context.Context, uint16, uint16) error { return nil }

func TestWorkspacePreviewProxyDoesNotForwardProductCredentials(t *testing.T) {
	target, err := url.Parse("http://127.0.0.1:4317")
	require.NoError(t, err)
	proxy := newWorkspacePreviewProxy(target, "/api/repos/alice/demo/workspaces/ws/preview/4317")
	request := httptest.NewRequest(http.MethodGet, "https://smithers.test/private", nil)
	for _, header := range workspacePreviewCredentialHeaders {
		request.Header.Set(header, "secret")
	}
	request.Header.Set("Forwarded", "for=attacker")
	request.Header.Set("X-Forwarded-For", "attacker")
	request.Header.Set("X-Forwarded-Host", "attacker.example")
	request.Header.Set("X-Forwarded-Proto", "https")

	proxy.Director(request)

	for _, header := range workspacePreviewCredentialHeaders {
		require.Empty(t, request.Header.Get(header), header)
	}
	require.Empty(t, request.Header.Get("Forwarded"))
	require.Empty(t, request.Header.Get("X-Forwarded-For"))
	require.Empty(t, request.Header.Get("X-Forwarded-Host"))
	require.Empty(t, request.Header.Get("X-Forwarded-Proto"))
	require.Equal(t, target.Host, request.Host)
	require.Equal(t, "/api/repos/alice/demo/workspaces/ws/preview/4317", request.Header.Get("X-Forwarded-Prefix"))

	response := &http.Response{Header: http.Header{"Set-Cookie": []string{"smithers_session=forged"}}}
	require.NoError(t, proxy.ModifyResponse(response))
	require.Empty(t, response.Header.Values("Set-Cookie"))
}

func TestRuntimeTerminalBackendClosesSharedTerminalOnce(t *testing.T) {
	terminal := &countingRuntimeTerminal{}
	client, session, err := newRuntimeTerminalBackend(terminal)
	require.NoError(t, err)
	require.NoError(t, session.Close())
	require.NoError(t, client.Close())
	require.EqualValues(t, 1, terminal.closes.Load())
}
