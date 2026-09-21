package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	. "github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type clientCovRoundTripFunc func(*http.Request) (*http.Response, error)

func (f clientCovRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestClient_Cov_DomainMappingStopAndForkFailures(t *testing.T) {
	t.Parallel()

	t.Run("domain mapping paths escape domain and stop vm parses response", func(t *testing.T) {
		t.Parallel()

		var createReq PublishIngressRequest
		var deletePath string
		var stopCalled bool

		mux := http.NewServeMux()
		mux.HandleFunc("POST /v1/ingress/preview one.preview.jjhub.tech", func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/v1/ingress/preview%20one.preview.jjhub.tech", r.URL.EscapedPath())
			body, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(body, &createReq))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(IngressRoute{
				ID:        "mapping-1",
				Hostname:  "preview one.preview.jjhub.tech",
				SandboxID: createReq.SandboxID,
				Port:      createReq.Port,
			})
		})
		mux.HandleFunc("DELETE /v1/ingress/preview one.preview.jjhub.tech", func(w http.ResponseWriter, r *http.Request) {
			deletePath = r.URL.EscapedPath()
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("POST /v1/sandboxes/vm-stop/stop", func(w http.ResponseWriter, r *http.Request) {
			stopCalled = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(StopResult{
				SandboxID: "vm-stop",
				RuntimeID: "inst-stop",
			})
		})

		server := httptest.NewServer(mux)
		defer server.Close()

		client := NewClient(server.URL, "secret-api-key")
		ctx := context.Background()

		mapping, err := client.PublishIngress(ctx, "preview one.preview.jjhub.tech", PublishIngressRequest{
			SandboxID: "vm-domain",
			Port:      8080,
		})
		require.NoError(t, err)
		assert.Equal(t, "mapping-1", mapping.ID)
		assert.Equal(t, "vm-domain", createReq.SandboxID)
		assert.EqualValues(t, 8080, createReq.Port)

		require.NoError(t, client.RevokeIngress(ctx, "preview one.preview.jjhub.tech"))
		assert.Equal(t, "/v1/ingress/preview%20one.preview.jjhub.tech", deletePath)

		stopResp, err := client.StopSandbox(ctx, "vm-stop")
		require.NoError(t, err)
		assert.True(t, stopCalled)
		assert.Equal(t, "vm-stop", stopResp.SandboxID)
		assert.Equal(t, "inst-stop", stopResp.RuntimeID)
	})

	t.Run("fork propagates api error", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/v1/sandboxes/vm-source/fork", r.URL.Path)
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"FORK_BUSY","message":"source vm is busy"}`))
		}))
		defer server.Close()

		client := NewClient(server.URL, "secret-api-key")
		_, err := client.ForkSandbox(context.Background(), "vm-source", ForkRequest{})
		require.Error(t, err)

		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr)
		assert.Equal(t, http.StatusConflict, statusErr.StatusCode)
		assert.Equal(t, "FORK_BUSY", statusErr.ErrorCode)
	})

	t.Run("fork rejects a response without a sandbox id", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}))
		defer server.Close()

		client := NewClient(server.URL, "secret-api-key")
		_, err := client.ForkSandbox(context.Background(), "vm-source", ForkRequest{})
		require.EqualError(t, err, "sandbox fork response did not include the created sandbox id")
	})
}

func TestClient_Cov_DoJSONFailuresAndMetricsLabels(t *testing.T) {
	t.Parallel()

	t.Run("marshal request failure still observes request", func(t *testing.T) {
		t.Parallel()

		observer := &mockAPIRequestObserver{}
		client := NewClient("http://example.invalid", "", WithAPIRequestObserver(observer))

		err := client.doJSON(context.Background(), http.MethodPost, "/bad", "/bad", math.Inf(1), nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "marshal microsandbox request")
		assert.Equal(t, http.MethodPost, observer.method)
		assert.Equal(t, "/bad", observer.endpoint)
	})

	t.Run("request construction failure", func(t *testing.T) {
		t.Parallel()

		client := &Client{baseURL: "http://[::1", httpClient: http.DefaultClient}
		err := client.doJSON(context.Background(), http.MethodGet, "/bad", "/bad", nil, nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create microsandbox request")
	})

	t.Run("transport failure increments transport metric", func(t *testing.T) {
		t.Parallel()

		observer := &mockAPIRequestObserver{}
		client := NewClient("http://sandbox.invalid", "", WithAPIRequestObserver(observer), WithHTTPClient(&http.Client{
			Transport: clientCovRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("dial failed")
			}),
		}))

		err := client.doJSON(context.Background(), http.MethodGet, "/v1/sandboxes/vm-1", "/v1/sandboxes/{id}", nil, nil)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "sandbox request failed")
		assert.Equal(t, "/v1/sandboxes/{id}", observer.errorEndpoint)
		assert.Equal(t, "transport_error", observer.errorCode)
	})

	t.Run("decode response failure", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":`))
		}))
		defer server.Close()

		client := NewClient(server.URL, "")
		var out CreateResult
		err := client.doJSON(context.Background(), http.MethodGet, "/v1/sandboxes/vm-1", "/v1/sandboxes/{id}", nil, &out)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode microsandbox response")
	})

	t.Run("observe error handles nils and blank code", func(t *testing.T) {
		t.Parallel()

		var nilClient *Client
		nilClient.observeError("/ignored", "ignored")

		(&Client{}).observeError("/ignored", "ignored")

		observer := &mockAPIRequestObserver{}
		client := NewClient("http://example.invalid", "", WithAPIRequestObserver(observer))
		client.observeError("/endpoint", " ")
		assert.Equal(t, "/endpoint", observer.errorEndpoint)
		assert.Equal(t, "unknown", observer.errorCode)
	})

	t.Run("metrics error code matrix", func(t *testing.T) {
		t.Parallel()

		tests := []struct {
			status int
			want   string
		}{
			{http.StatusBadRequest, "bad_request"},
			{http.StatusUnauthorized, "unauthorized"},
			{http.StatusForbidden, "forbidden"},
			{http.StatusNotFound, "not_found"},
			{http.StatusConflict, "conflict"},
			{http.StatusTooManyRequests, "rate_limited"},
			{http.StatusInternalServerError, "server_error"},
			{http.StatusTeapot, "client_error"},
			{http.StatusFound, "unexpected_status"},
		}

		for _, tc := range tests {
			assert.Equal(t, tc.want, metricsErrorCode(tc.status), strings.TrimSpace(http.StatusText(tc.status)))
		}
	})
}
