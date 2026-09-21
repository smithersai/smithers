package wsrunner

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// clientCoverRoundTripFunc is an http.RoundTripper backed by a function. It is
// intentionally NOT an *http.Transport so it can be used to force the nil
// branch in NewAPIClient.
type clientCoverRoundTripFunc func(*http.Request) (*http.Response, error)

func (f clientCoverRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// clientCoverErrReader always fails on Read so error-body/response-body read
// paths can be exercised.
type clientCoverErrReader struct{}

func (clientCoverErrReader) Read([]byte) (int, error) { return 0, errors.New("boom read") }

// clientCoverResponse builds a canned *http.Response whose body fails on Read.
func clientCoverErrBodyResponse(status int) clientCoverRoundTripFunc {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(clientCoverErrReader{}),
			Header:     make(http.Header),
		}, nil
	}
}

// TestClient_Cover_NewAPIClientNilTransport forces the branch where
// http.DefaultTransport is not an *http.Transport, so NewAPIClient must build a
// fresh transport. Non-parallel so it runs during the sequential phase and does
// not disturb the parallel HTTP tests.
func TestClient_Cover_NewAPIClientNilTransport(t *testing.T) {
	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })

	http.DefaultTransport = clientCoverRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unused")
	})

	c := NewAPIClient("http://example.invalid", "tok")
	require.NotNil(t, c)
	require.NotNil(t, c.client)
	require.NotNil(t, c.client.Transport)
	assert.Equal(t, "tok", c.agentToken)
}

// TestClient_Cover_DoMarshalError covers the json.Marshal failure branch in do.
func TestClient_Cover_DoMarshalError(t *testing.T) {
	t.Parallel()

	c := newTestClient("http://example.invalid")
	unmarshalable := map[string]any{"bad": make(chan int)}

	_, err := c.do(context.Background(), http.MethodPost, "/x", unmarshalable)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported type")
}

// TestClient_Cover_DoAttemptsClampedToOne covers the attempts<1 clamp in do.
func TestClient_Cover_DoAttemptsClampedToOne(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	c := newTestClient(server.URL)
	c.maxAttempts = 0 // must be clamped up to 1 so the single attempt runs

	body, err := c.do(context.Background(), http.MethodGet, "/x", nil)
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(body))
}

// TestClient_Cover_DoOnceNewRequestError covers the NewRequestWithContext error
// branch (invalid HTTP method) and confirms it is not retried.
func TestClient_Cover_DoOnceNewRequestError(t *testing.T) {
	t.Parallel()

	c := newTestClient("http://example.invalid")
	_, err := c.do(context.Background(), "IN VALID", "/x", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid method")
}

// TestClient_Cover_DoOnceErrorBodyReadFailure covers the readErrorBody failure
// branch inside doOnce (status >= 400 but the body cannot be read). Uses a
// non-retryable status so it returns after a single attempt.
func TestClient_Cover_DoOnceErrorBodyReadFailure(t *testing.T) {
	t.Parallel()

	c := newTestClient("http://example.invalid")
	c.client = &http.Client{Transport: clientCoverErrBodyResponse(http.StatusTeapot)}

	_, err := c.do(context.Background(), http.MethodGet, "/x", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read API error response")
	assert.Contains(t, err.Error(), "boom read")
}

// TestClient_Cover_DoOnceResponseBodyReadFailure covers the readResponseBody
// generic (non-too-large) failure branch inside doOnce.
func TestClient_Cover_DoOnceResponseBodyReadFailure(t *testing.T) {
	t.Parallel()

	c := newTestClient("http://example.invalid")
	c.client = &http.Client{Transport: clientCoverErrBodyResponse(http.StatusOK)}

	_, err := c.do(context.Background(), http.MethodGet, "/x", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "read API response")
	assert.Contains(t, err.Error(), "boom read")
}

// TestClient_Cover_ReadResponseBody exercises readResponseBody directly across
// its nil, error, and within-limit branches.
func TestClient_Cover_ReadResponseBody(t *testing.T) {
	t.Parallel()

	t.Run("nil reader returns nil", func(t *testing.T) {
		t.Parallel()
		body, err := readResponseBody(nil, 16)
		require.NoError(t, err)
		assert.Nil(t, body)
	})

	t.Run("read error propagates", func(t *testing.T) {
		t.Parallel()
		_, err := readResponseBody(clientCoverErrReader{}, 16)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "boom read")
	})

	t.Run("within limit returns bytes", func(t *testing.T) {
		t.Parallel()
		body, err := readResponseBody(strings.NewReader("hello"), 16)
		require.NoError(t, err)
		assert.Equal(t, "hello", string(body))
	})

	t.Run("exactly at limit is allowed", func(t *testing.T) {
		t.Parallel()
		body, err := readResponseBody(strings.NewReader("abcd"), 4)
		require.NoError(t, err)
		assert.Equal(t, "abcd", string(body))
	})
}

// TestClient_Cover_ReadErrorBody exercises readErrorBody directly across its
// nil, error, and truncated-empty branches.
func TestClient_Cover_ReadErrorBody(t *testing.T) {
	t.Parallel()

	t.Run("nil reader returns empty", func(t *testing.T) {
		t.Parallel()
		msg, err := readErrorBody(nil, 16)
		require.NoError(t, err)
		assert.Equal(t, "", msg)
	})

	t.Run("read error propagates", func(t *testing.T) {
		t.Parallel()
		_, err := readErrorBody(clientCoverErrReader{}, 16)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "boom read")
	})

	t.Run("truncated whitespace body reports truncation notice", func(t *testing.T) {
		t.Parallel()
		// limit bytes are all whitespace, then extra bytes push it over the
		// limit so truncated==true while the trimmed message is empty.
		msg, err := readErrorBody(strings.NewReader(strings.Repeat(" ", 4)+"xxxx"), 4)
		require.NoError(t, err)
		assert.Equal(t, "response body truncated", msg)
	})

	t.Run("non-truncated body trimmed", func(t *testing.T) {
		t.Parallel()
		msg, err := readErrorBody(strings.NewReader("  oops  "), 64)
		require.NoError(t, err)
		assert.Equal(t, "oops", msg)
	})
}

// TestClient_Cover_SleepWithContextZeroDelay covers the delay<=0 fast path.
func TestClient_Cover_SleepWithContextZeroDelay(t *testing.T) {
	t.Parallel()

	require.NoError(t, sleepWithContext(context.Background(), 0))
	require.NoError(t, sleepWithContext(context.Background(), -time.Second))
}

// TestClient_Cover_ExchangeWebRTCErrors covers the do-error and unmarshal-error
// branches of ExchangeWebRTC.
func TestClient_Cover_ExchangeWebRTCErrors(t *testing.T) {
	t.Parallel()

	t.Run("transport error surfaces", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		server.Close()

		c := newTestClient(server.URL)
		c.maxAttempts = 1
		_, err := c.ExchangeWebRTC(context.Background(), "sess", "sdp", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "workspace runner API request failed")
	})

	t.Run("invalid json response", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "not-json")
		}))
		defer server.Close()

		c := newTestClient(server.URL)
		_, err := c.ExchangeWebRTC(context.Background(), "sess", "sdp", "")
		require.Error(t, err)
	})
}

// TestClient_Cover_GetSessionDoError covers the do-error branch of GetSession.
func TestClient_Cover_GetSessionDoError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	server.Close()

	c := newTestClient(server.URL)
	c.maxAttempts = 1
	_, err := c.GetSession(context.Background(), "sess")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "workspace runner API request failed")
}
