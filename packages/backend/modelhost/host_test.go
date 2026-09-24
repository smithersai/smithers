package modelhost

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/ports"
)

type testLauncher struct {
	lease Lease
}

func (launcher testLauncher) LaunchChatHost(_ context.Context, _ ports.ChatTurnGrant, _ Binding) (Lease, error) {
	return launcher.lease, nil
}

type testLease struct {
	origin string
	client *http.Client
	closed bool
}

func (lease *testLease) Endpoint() (string, *http.Client, string) {
	if lease.client != nil {
		return lease.origin, lease.client, "private-token"
	}
	return lease.origin, http.DefaultClient, "private-token"
}

func (lease *testLease) Close(context.Context) error {
	lease.closed = true
	return nil
}

func TestHostScopesResolutionAndCleansFailedTurn(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/v1/chat/turn", request.URL.Path)
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	resolved := false
	host, err := New(ResolverFunc(func(_ context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 7, ownerID)
		require.EqualValues(t, 11, repositoryID)
		require.JSONEq(t, `{"runId":"run-1"}`, string(request))
		resolved = true
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	err = host.RunChatTurn(context.Background(), ports.ChatTurnGrant{
		OwnerID: 7, RepositoryID: 11, Request: json.RawMessage(`{"runId":"run-1"}`),
	})
	require.ErrorContains(t, err, "status 503")
	require.True(t, resolved)
	require.True(t, lease.closed)
}

func TestChatTurnOutlivesTheLeaseClientTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL, client: &http.Client{Timeout: 50 * time.Millisecond}}
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	require.NoError(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{OwnerID: 7, Request: json.RawMessage(`{}`)}))
	require.Equal(t, 50*time.Millisecond, lease.client.Timeout)
}

func TestModelStreamUsesOwnerResolverAndPrivateHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/v1/model/stream", request.URL.Path)
		require.Equal(t, "Bearer private-token", request.Header.Get("Authorization"))
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		require.Contains(t, string(body), `"ownerId":7`)
		require.Contains(t, string(body), `"messages"`)
		_, _ = io.WriteString(w, "{\"type\":\"delta\",\"text\":\"provider token\"}\n")
	}))
	defer server.Close()
	lease := &testLease{origin: server.URL}
	resolved := false
	host, err := New(ResolverFunc(func(_ context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
		require.EqualValues(t, 7, ownerID)
		require.EqualValues(t, 11, repositoryID)
		require.Contains(t, string(request), `"ownerId":7`)
		resolved = true
		return Binding{}, nil
	}), testLauncher{lease: lease})
	require.NoError(t, err)
	stream, err := host.RunModelStream(context.Background(), ports.ModelStreamGrant{
		OwnerID: 7, RepositoryID: 11, Request: json.RawMessage(`{"messages":[{"role":"user","content":"hi"}]}`),
	})
	require.NoError(t, err)
	defer stream.Close()
	body, err := io.ReadAll(stream)
	require.NoError(t, err)
	require.True(t, strings.Contains(string(body), "provider token"))
	require.True(t, resolved)
	require.True(t, lease.closed)
}
