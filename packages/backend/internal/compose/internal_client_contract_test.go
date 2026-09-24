package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	runnerclient "github.com/smithersai/smithers/packages/backend/internal/runner/client"
)

type recordedCall struct {
	method string
	path   string
	status int
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

// Every /internal endpoint an in-repo client calls must be registered by the
// server router. A client of a contract the server does not serve (404/405)
// fails here instead of in production. This drives the real client methods, so
// a new client call is covered without editing a path table.
func TestInternalClients_CallOnlyRegisteredRoutes(t *testing.T) {
	const sharedToken = "shared-runner-pod-token"
	router := buildInternalAuthTestRouter(t, sharedToken)

	var mu sync.Mutex
	var calls []recordedCall
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		router.ServeHTTP(rec, r)
		mu.Lock()
		calls = append(calls, recordedCall{method: r.Method, path: r.URL.Path, status: rec.status})
		mu.Unlock()
	}))
	t.Cleanup(server.Close)

	client, err := runnerclient.New(runnerclient.Config{BaseURL: server.URL, Token: sharedToken})
	require.NoError(t, err)

	ctx := context.Background()
	// Responses may be errors (auth, mock data); only route registration matters.
	_, _ = client.Register(ctx, "runner-1", nil)
	_, _ = client.ClaimTask(ctx, 1)
	_ = client.Heartbeat(ctx, 1)
	_ = client.TerminateRunner(ctx, 1)
	_ = client.CompleteTask(ctx, 1, 1, "done", "")
	_, _ = client.GetTaskStatus(ctx, 1, 1)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, calls, 6, "every runner client method must reach the router")
	for _, call := range calls {
		require.NotContains(t, []int{http.StatusNotFound, http.StatusMethodNotAllowed}, call.status,
			"client calls %s %s, which the router does not register", call.method, call.path)
	}
}
