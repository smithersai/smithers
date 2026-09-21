package repohost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClient_DeleteRepo_Success(t *testing.T) {
	t.Parallel()

	var method string
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteRepo(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, http.MethodDelete, method)
	assert.Equal(t, "/repos/alice/demo", path)
}

func TestClient_DeleteRepo_NotFoundIsTreatedAsSuccess(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteRepo(context.Background(), "alice", "missing")
	require.NoError(t, err)
}

func TestClient_DeleteRepo_UnexpectedStatusReturnsError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("repo-host unavailable"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteRepo(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
	assert.NotContains(t, err.Error(), "repo-host unavailable")
}

func TestClient_DeleteRepo_RespectsCanceledContext(t *testing.T) {
	t.Parallel()

	var sawRequest atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawRequest.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := client.DeleteRepo(ctx, "alice", "demo")
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.False(t, sawRequest.Load())
}
