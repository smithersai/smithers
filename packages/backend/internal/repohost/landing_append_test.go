package repohost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLandingAppendClientNeverFallsBackToLegacyRoute(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "/repos/alice:demo/land/append", r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, err := client.LandChanges(context.Background(), "alice", "demo", LandRequest{Append: &LandAppend{Description: "delivery"}})
	require.Error(t, err)
	require.Equal(t, 1, calls)
}
