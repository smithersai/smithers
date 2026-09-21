package wsrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestClient(baseURL string) *APIClient {
	c := NewAPIClient(baseURL, "agent-token")
	c.retryDelay = time.Millisecond
	return c
}

func TestAPIClient_SendsBearerTokenAndJSON(t *testing.T) {
	t.Parallel()

	var authHeader, contentType, method, path string
	var body map[string]string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		contentType = r.Header.Get("Content-Type")
		method = r.Method
		path = r.URL.Path

		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(raw, &body))

		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	require.NoError(t, client.ReportWorkspaceStatus(context.Background(), "ws_1", "running"))

	assert.Equal(t, "Bearer agent-token", authHeader)
	assert.Equal(t, "application/json", contentType)
	assert.Equal(t, http.MethodPost, method)
	assert.Equal(t, "/internal/workspace/ws_1/status", path)
	assert.Equal(t, map[string]string{"status": "running"}, body)
}

func TestAPIClient_GetRequestHasNoContentType(t *testing.T) {
	t.Parallel()

	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		_, _ = w.Write([]byte(`{"id":"ws_1","status":"running"}`))
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	info, err := client.GetWorkspace(context.Background(), "ws_1")
	require.NoError(t, err)

	assert.Empty(t, contentType)
	assert.Equal(t, "ws_1", info.ID)
	assert.Equal(t, "running", info.Status)
}

func TestAPIClient_ErrorMapping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		status  int
		body    string
		wantErr string
	}{
		{name: "error with body", status: http.StatusForbidden, body: "bad agent token", wantErr: "API error 403: bad agent token"},
		{name: "error without body", status: http.StatusNotFound, body: "", wantErr: "API error 404"},
		{name: "whitespace body treated as empty", status: http.StatusConflict, body: "  \n ", wantErr: "API error 409"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()

			client := newTestClient(server.URL)
			err := client.ReportStatus(context.Background(), "sess_1", "failed")
			require.Error(t, err)
			assert.Equal(t, tt.wantErr, err.Error())
		})
	}
}

func TestAPIClient_ErrorBodyTruncated(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, strings.Repeat("x", int(maxErrorBodyBytes)+100))
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	err := client.ReportStatus(context.Background(), "sess_1", "failed")
	require.Error(t, err)
	assert.True(t, strings.HasSuffix(err.Error(), "(truncated)"), "error should note truncation: %s", err.Error())
	assert.LessOrEqual(t, len(err.Error()), int(maxErrorBodyBytes)+100)
}

func TestAPIClient_ResponseBodyTooLarge(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("a", 32))
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	client.maxResponseBytes = 16

	_, err := client.do(context.Background(), http.MethodGet, "/internal/workspace/ws_1", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "API response exceeded 16 bytes")
}

func TestAPIClient_RetriesOn5xxThenSucceeds(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"id":"sess_1","status":"pending","client_sdp":"sdp-blob"}`))
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	sess, err := client.GetSession(context.Background(), "sess_1")
	require.NoError(t, err)

	assert.EqualValues(t, 3, calls.Load())
	assert.Equal(t, "sess_1", sess.ID)
	assert.Equal(t, "sdp-blob", sess.ClientSDP)
}

func TestAPIClient_DoesNotRetryOn4xx(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "nope")
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	_, err := client.GetWorkspace(context.Background(), "ws_1")
	require.Error(t, err)

	assert.EqualValues(t, 1, calls.Load(), "401 must not be retried")
	assert.Equal(t, "API error 401: nope", err.Error())
}

func TestAPIClient_RetriesExhausted(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	err := client.ReportWorkspaceStatus(context.Background(), "ws_1", "running")
	require.Error(t, err)

	assert.EqualValues(t, defaultAPIMaxAttempts, calls.Load())
	assert.Equal(t, "API error 502", err.Error())
}

func TestAPIClient_RetriesOnTransportError(t *testing.T) {
	t.Parallel()

	// Point at a server that is already closed so every attempt fails at the
	// transport layer.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	server.Close()

	client := newTestClient(server.URL)
	client.maxAttempts = 2

	err := client.ReportStatus(context.Background(), "sess_1", "running")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "workspace runner API request failed")
}

func TestAPIClient_ContextCancelStopsRetries(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	client := newTestClient(server.URL)
	client.retryDelay = 50 * time.Millisecond

	// Cancel after the first attempt has fired.
	go func() {
		for calls.Load() == 0 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()

	err := client.ReportWorkspaceStatus(ctx, "ws_1", "running")
	require.Error(t, err)
	assert.LessOrEqual(t, calls.Load(), int32(2), "cancel should stop the retry loop early")
}

func TestAPIClient_ExchangeWebRTC(t *testing.T) {
	t.Parallel()

	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/workspace/sessions/sess_9/webrtc", r.URL.Path)
		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(raw, &payload))
		_, _ = w.Write([]byte(`{"id":"sess_9","status":"running","client_ice_candidates":"cand"}`))
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	sess, err := client.ExchangeWebRTC(context.Background(), "sess_9", "offer-sdp", "ice-list")
	require.NoError(t, err)

	assert.Equal(t, "offer-sdp", payload["sdp"])
	assert.Equal(t, "ice-list", payload["ice_candidates"])
	assert.Equal(t, "sess_9", sess.ID)
	assert.Equal(t, "cand", sess.ClientICECandidates)
}

func TestAPIClient_InvalidJSONResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "not json")
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	_, err := client.GetWorkspace(context.Background(), "ws_1")
	require.Error(t, err)

	_, err = client.GetSession(context.Background(), "sess_1")
	require.Error(t, err)
}

func TestShouldRetryAPIRequest(t *testing.T) {
	t.Parallel()

	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	tests := []struct {
		name   string
		ctx    context.Context
		status int
		want   bool
	}{
		{name: "canceled context never retries", ctx: canceled, status: http.StatusInternalServerError, want: false},
		{name: "408 retries", ctx: context.Background(), status: http.StatusRequestTimeout, want: true},
		{name: "429 retries", ctx: context.Background(), status: http.StatusTooManyRequests, want: true},
		{name: "500 retries", ctx: context.Background(), status: http.StatusInternalServerError, want: true},
		{name: "502 retries", ctx: context.Background(), status: http.StatusBadGateway, want: true},
		{name: "503 retries", ctx: context.Background(), status: http.StatusServiceUnavailable, want: true},
		{name: "504 retries", ctx: context.Background(), status: http.StatusGatewayTimeout, want: true},
		{name: "400 does not retry", ctx: context.Background(), status: http.StatusBadRequest, want: false},
		{name: "401 does not retry", ctx: context.Background(), status: http.StatusUnauthorized, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, shouldRetryAPIRequest(tt.ctx, tt.status, nil))
		})
	}
}
