package repohost

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type rotatingStagedResolver struct{ url string }

func (r *rotatingStagedResolver) ResolveURL(context.Context, string, string) (string, error) {
	return "", fmt.Errorf("namespace URL lookup must not route a durable stage")
}
func (r *rotatingStagedResolver) ResolveStorageRouteKey(context.Context, string, string) (string, error) {
	return "stable-route", nil
}
func (r *rotatingStagedResolver) ResolveStorageSetURL(_ context.Context, id string) (string, error) {
	if id != "stable-route" {
		return "", fmt.Errorf("unexpected route %q", id)
	}
	return r.url, nil
}

func TestPreparedStagesRecoverThroughCurrentRoute(t *testing.T) {
	ctx := context.Background()
	resolver := &rotatingStagedResolver{url: "http://old-node.test"}
	client := NewClient(resolver, "secret")
	client.httpClient.Transport = timeoutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "new-node.test", req.URL.Host)
		var token string
		switch req.URL.Path {
		case "/repos/delete-stages":
			var body stageDeleteRepoRequest
			require.NoError(t, json.NewDecoder(req.Body).Decode(&body))
			token = body.Token
		case "/repos/move-stages":
			var body moveRepoRequest
			require.NoError(t, json.NewDecoder(req.Body).Decode(&body))
			token = body.Token
		default:
			return emptyResponse(req, http.StatusNoContent), nil
		}
		return &http.Response{StatusCode: http.StatusCreated, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"token":%q}`, token))), ContentLength: -1, Request: req}, nil
	})
	deletion, err := client.PrepareStagedDelete(ctx, "alice", "demo")
	require.NoError(t, err)
	require.Equal(t, "stable-route", deletion.StorageRouteKey)
	move, err := client.PrepareStagedMove(ctx, "alice", "demo", "bob", "demo")
	require.NoError(t, err)
	require.Equal(t, "stable-route", move.StorageRouteKey)
	resolver.url = "http://new-node.test"
	deletion.BaseURL = "" // only the persisted route and token survive a restart
	move.BaseURL = ""
	require.NoError(t, client.ExecuteStagedDelete(ctx, deletion))
	require.NoError(t, client.FinalizeStagedDelete(ctx, deletion))
	require.NoError(t, client.ExecuteStagedMove(ctx, move))
	require.NoError(t, client.RollbackStagedMove(ctx, move))
}
