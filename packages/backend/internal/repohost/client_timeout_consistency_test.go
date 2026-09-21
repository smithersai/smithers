package repohost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type timeoutRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn timeoutRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func emptyResponse(req *http.Request, status int) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Header:        make(http.Header),
		Body:          io.NopCloser(strings.NewReader("")),
		ContentLength: 0,
		Request:       req,
	}
}

func TestNewClient_UsesRequestScopedReadTimeoutWithoutBlanketClientTimeout(t *testing.T) {
	t.Parallel()

	client := NewClient(&StaticStorageSetResolver{URL: "http://repo-host.test"}, "token")
	assert.Zero(t, client.httpClient.Timeout, "a blanket timeout can abandon an in-flight mutation")

	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		deadline, ok := req.Context().Deadline()
		require.True(t, ok, "read requests must retain a bounded deadline")
		remaining := time.Until(deadline)
		assert.Greater(t, remaining, defaultReadTimeout-time.Second)
		assert.LessOrEqual(t, remaining, defaultReadTimeout)
		return emptyResponse(req, http.StatusOK), nil
	})

	require.NoError(t, client.Health(context.Background(), "http://repo-host.test"))
}

func TestClient_MutationPreservesCallerConsistencyDeadlineWithoutShorteningIt(t *testing.T) {
	t.Parallel()

	client := NewClient(&StaticStorageSetResolver{URL: "http://repo-host.test"}, "token")
	wantDeadline := time.Now().Add(2 * time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), wantDeadline)
	defer cancel()

	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotDeadline, ok := req.Context().Deadline()
		require.True(t, ok)
		assert.WithinDuration(t, wantDeadline, gotDeadline, time.Millisecond)
		return emptyResponse(req, http.StatusCreated), nil
	})

	require.NoError(t, client.InitRepo(ctx, "alice", "demo", "main", false))
}

func TestClient_MutationWithoutCallerDeadlineGetsNoSyntheticDeadline(t *testing.T) {
	t.Parallel()

	client := NewClient(&StaticStorageSetResolver{URL: "http://repo-host.test"}, "token")
	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		_, ok := req.Context().Deadline()
		assert.False(t, ok, "the client must not recreate the removed 30-second mutation timeout")
		return emptyResponse(req, http.StatusCreated), nil
	})

	require.NoError(t, client.InitRepo(context.Background(), "alice", "demo", "main", false))
}

type moveNamespaceResolver struct {
	url   string
	calls []string
}

func (r *moveNamespaceResolver) ResolveURL(_ context.Context, owner, repo string) (string, error) {
	r.calls = append(r.calls, owner+"/"+repo)
	if owner == "new-owner" {
		return "", errors.New("repository no longer visible under source namespace")
	}
	return r.url, nil
}

func TestClient_MoveRepoFallsBackToDestinationNamespaceForCompensation(t *testing.T) {
	t.Parallel()

	resolver := &moveNamespaceResolver{url: "http://repo-host.test"}
	client := NewClient(resolver, "token")
	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		assert.Equal(t, "/repos/move", req.URL.Path)
		return emptyResponse(req, http.StatusOK), nil
	})

	require.NoError(t, client.MoveRepo(context.Background(), "new-owner", "demo", "old-owner", "demo"))
	assert.Equal(t, []string{"new-owner/demo", "old-owner/demo"}, resolver.calls)
}

func TestClient_StageDeleteReturnsKnownHandleWhenResponseIsLost(t *testing.T) {
	t.Parallel()

	resolver := &moveNamespaceResolver{url: "http://repo-host.test"}
	client := NewClient(resolver, "token")
	var requestToken string
	var restored bool
	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		_, hasDeadline := req.Context().Deadline()
		assert.False(t, hasDeadline, "staged delete mutations must not inherit the read timeout")
		switch {
		case req.URL.Path == "/repos/delete-stages":
			var body stageDeleteRepoRequest
			require.NoError(t, json.NewDecoder(req.Body).Decode(&body))
			requestToken = body.Token
			assert.Equal(t, "alice", body.Owner)
			assert.Equal(t, "demo", body.Repo)
			// Model repo-host completing the rename but the transport losing the
			// response before the client can observe its token.
			return nil, errors.New("response lost after stage completed")
		case req.URL.Path == "/repos/delete-stages/"+requestToken+"/restore":
			restored = true
			return emptyResponse(req, http.StatusNoContent), nil
		default:
			t.Fatalf("unexpected request path %q", req.URL.Path)
			return nil, nil
		}
	})

	staged, err := client.StageDeleteRepo(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, requestToken, staged.Token)
	assert.Equal(t, "http://repo-host.test", staged.BaseURL)
	assert.Len(t, staged.Token, 64)

	require.NoError(t, client.RestoreStagedDelete(context.Background(), staged))
	assert.True(t, restored)
	assert.Equal(t, []string{"alice/demo"}, resolver.calls, "restore must use the URL captured before the row disappears")
}

func TestClient_StageMoveReturnsKnownHandleWhenResponseIsLost(t *testing.T) {
	t.Parallel()

	resolver := &moveNamespaceResolver{url: "http://repo-host.test"}
	client := NewClient(resolver, "token")
	var requestToken string
	var rolledBack bool
	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		_, hasDeadline := req.Context().Deadline()
		assert.False(t, hasDeadline, "staged move mutations must not inherit the read timeout")
		switch {
		case req.URL.Path == "/repos/move-stages":
			var body moveRepoRequest
			require.NoError(t, json.NewDecoder(req.Body).Decode(&body))
			requestToken = body.Token
			assert.Equal(t, "alice", body.SrcOwner)
			assert.Equal(t, "bob", body.DstOwner)
			return nil, errors.New("response lost after move completed")
		case req.URL.Path == "/repos/move-stages/"+requestToken+"/rollback":
			rolledBack = true
			return emptyResponse(req, http.StatusNoContent), nil
		default:
			t.Fatalf("unexpected request path %q", req.URL.Path)
			return nil, nil
		}
	})

	staged, err := client.StageMoveRepo(context.Background(), "alice", "demo", "bob", "demo")
	require.Error(t, err)
	assert.Equal(t, requestToken, staged.Token)
	assert.Equal(t, "http://repo-host.test", staged.BaseURL)
	assert.Len(t, staged.Token, 64)

	require.NoError(t, client.RollbackStagedMove(context.Background(), staged))
	assert.True(t, rolledBack)
	assert.Equal(t, []string{"alice/demo"}, resolver.calls, "rollback must use the URL captured before ownership changes")
}
