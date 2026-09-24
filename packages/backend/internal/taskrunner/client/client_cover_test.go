package client

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

// clientCoverErrReader is an io.Reader that always fails, used to exercise the
// error path of readErrorBody / unexpectedStatusError.
type clientCoverErrReader struct{}

func (clientCoverErrReader) Read(p []byte) (int, error) {
	return 0, errors.New("clientCover forced read error")
}

// clientCoverNewClient builds a client pointed at an arbitrary base URL for
// tests that exercise the unexported do/readErrorBody seams directly.
func clientCoverNewClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	c, err := New(Config{BaseURL: baseURL, Token: "token"})
	require.NoError(t, err)
	return c
}

func TestNew_Cover_URLParseError(t *testing.T) {
	t.Parallel()

	// A control character survives normalizeBaseURL (which only trims spaces
	// and trailing slashes) and makes url.Parse fail.
	_, err := New(Config{BaseURL: "http://a\x7fb", Token: "token"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid runner API base URL")
}

func TestNew_Cover_TimeoutOverride(t *testing.T) {
	t.Parallel()

	c, err := New(Config{BaseURL: "http://example.com", Token: "token", Timeout: 5 * time.Second})
	require.NoError(t, err)
	assert.Equal(t, 5*time.Second, c.httpClient.Timeout)
}

func TestNew_Cover_CustomClientZeroTimeoutGetsDefault(t *testing.T) {
	t.Parallel()

	custom := &http.Client{} // Timeout == 0
	c, err := New(Config{BaseURL: "http://example.com", Token: "token", HTTPClient: custom})
	require.NoError(t, err)
	// Zero-timeout custom clients are cloned and given the default timeout,
	// leaving the caller's client untouched.
	assert.Equal(t, defaultTimeout, c.httpClient.Timeout)
	assert.Equal(t, time.Duration(0), custom.Timeout)
	assert.NotSame(t, custom, c.httpClient)
}

func TestNew_Cover_CustomClientKeepsNonZeroTimeout(t *testing.T) {
	t.Parallel()

	custom := &http.Client{Timeout: 3 * time.Second}
	c, err := New(Config{BaseURL: "http://example.com", Token: "token", HTTPClient: custom})
	require.NoError(t, err)
	// No cfg.Timeout and a non-zero custom timeout => the client is used as-is.
	assert.Same(t, custom, c.httpClient)
	assert.Equal(t, 3*time.Second, c.httpClient.Timeout)
}

func TestRegister_Cover_ErrorStatus(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("kaboom"))
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	resp, err := c.Register(context.Background(), "runner-1", nil)
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "runner API returned 500")
	assert.Contains(t, err.Error(), "kaboom")
}

func TestRegister_Cover_DecodeError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not-json"))
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	resp, err := c.Register(context.Background(), "runner-1", nil)
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "decode API response")
}

func TestRegister_Cover_DoError(t *testing.T) {
	t.Parallel()

	c := clientCoverNewClient(t, "http://example.com")
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // request is cancelled before it can be sent

	resp, err := c.Register(ctx, "runner-1", nil)
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "runner API request failed")
}

func TestClaimTask_Cover_UnexpectedStatus(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("busy"))
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	task, err := c.ClaimTask(context.Background(), 7)
	require.Error(t, err)
	assert.Nil(t, task)
	assert.Contains(t, err.Error(), "runner API returned 409")
	assert.Contains(t, err.Error(), "busy")
}

func TestClaimTask_Cover_DecodeError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{bad"))
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	task, err := c.ClaimTask(context.Background(), 7)
	require.Error(t, err)
	assert.Nil(t, task)
	assert.Contains(t, err.Error(), "decode claim task response")
}

func TestClaimTask_Cover_DoError(t *testing.T) {
	t.Parallel()

	c := clientCoverNewClient(t, "http://example.com")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	task, err := c.ClaimTask(ctx, 7)
	require.Error(t, err)
	assert.Nil(t, task)
	assert.Contains(t, err.Error(), "runner API request failed")
}

func TestExpectNoContent_Cover_UnexpectedStatus(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	// Heartbeat funnels through expectNoContent; a non-204 status is an error.
	err := c.Heartbeat(context.Background(), 3)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "runner API returned 503")
}

func TestExpectNoContent_Cover_DoError(t *testing.T) {
	t.Parallel()

	c := clientCoverNewClient(t, "http://example.com")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := c.TerminateRunner(ctx, 15)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "runner API request failed")
}

func TestCompleteTask_Cover_OmitsEmptyError(t *testing.T) {
	t.Parallel()

	var sawErrorKey bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/tasks/22/complete", r.URL.Path)
		body, err := readAllString(r)
		require.NoError(t, err)
		sawErrorKey = strings.Contains(body, "\"error\"")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	// A blank error message must be omitted from the request body.
	require.NoError(t, c.CompleteTask(context.Background(), 22, 7, "succeeded", "   "))
	assert.False(t, sawErrorKey, "blank error message should be omitted")
}

func TestDoJSON_Cover_NilOut(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ignored-body"))
	}))
	defer server.Close()

	c := clientCoverNewClient(t, server.URL)
	// out == nil means the response body is not decoded and no error is returned.
	err := c.doJSON(context.Background(), http.MethodPost, "/internal/whatever", nil, http.StatusOK, nil)
	require.NoError(t, err)
}

func TestDo_Cover_MarshalError(t *testing.T) {
	t.Parallel()

	c := clientCoverNewClient(t, "http://example.com")
	// A channel cannot be marshaled to JSON => marshal error before any HTTP call.
	resp, status, err := c.do(context.Background(), http.MethodPost, "/x", make(chan int))
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Equal(t, 0, status)
	assert.Contains(t, err.Error(), "marshal API request")
}

func TestDo_Cover_BuildRequestError(t *testing.T) {
	t.Parallel()

	c := clientCoverNewClient(t, "http://example.com")
	// An invalid method (contains a space) fails http.NewRequestWithContext.
	resp, status, err := c.do(context.Background(), "BAD METHOD", "/x", nil)
	require.Error(t, err)
	assert.Nil(t, resp)
	assert.Equal(t, 0, status)
	assert.Contains(t, err.Error(), "build API request")
}

func TestUnexpectedStatusError_Cover(t *testing.T) {
	t.Parallel()

	t.Run("with message", func(t *testing.T) {
		t.Parallel()
		err := unexpectedStatusError(http.StatusBadRequest, strings.NewReader("nope"))
		require.Error(t, err)
		assert.Equal(t, "runner API returned 400: nope", err.Error())
	})

	t.Run("empty body", func(t *testing.T) {
		t.Parallel()
		err := unexpectedStatusError(http.StatusBadGateway, strings.NewReader("   "))
		require.Error(t, err)
		assert.Equal(t, "runner API returned 502", err.Error())
	})

	t.Run("read error", func(t *testing.T) {
		t.Parallel()
		err := unexpectedStatusError(http.StatusInternalServerError, clientCoverErrReader{})
		require.Error(t, err)
		assert.Equal(t, "runner API returned 500", err.Error())
	})
}

func TestReadErrorBody_Cover(t *testing.T) {
	t.Parallel()

	t.Run("nil body", func(t *testing.T) {
		t.Parallel()
		msg, err := readErrorBody(nil)
		require.NoError(t, err)
		assert.Equal(t, "", msg)
	})

	t.Run("read error", func(t *testing.T) {
		t.Parallel()
		msg, err := readErrorBody(clientCoverErrReader{})
		require.Error(t, err)
		assert.Equal(t, "", msg)
	})

	t.Run("truncates oversized body", func(t *testing.T) {
		t.Parallel()
		big := strings.Repeat("a", maxErrorBodyBytes+500)
		msg, err := readErrorBody(strings.NewReader(big))
		require.NoError(t, err)
		assert.Len(t, msg, maxErrorBodyBytes)
	})

	t.Run("trims whitespace", func(t *testing.T) {
		t.Parallel()
		msg, err := readErrorBody(strings.NewReader("  hello  "))
		require.NoError(t, err)
		assert.Equal(t, "hello", msg)
	})
}

// readAllString drains an *http.Request body into a string.
func readAllString(r *http.Request) (string, error) {
	if r.Body == nil {
		return "", nil
	}
	data, err := io.ReadAll(r.Body)
	return string(data), err
}
