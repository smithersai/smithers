package microsandbox

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Every ID a caller passes becomes exactly one escaped path segment. A raw
// "/", "?" or ".." would otherwise reach a different controller route, and
// every route runs with the admin bearer key.
func TestClientEscapesEveryIDPathSegment(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.EscapedPath()+"|"+r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "admin-key")
	ctx := context.Background()
	const id = "a/b?c=d"
	const escaped = "a%2Fb%3Fc=d"

	_, _ = client.ForkSandbox(ctx, id, sandbox.ForkRequest{})
	_, _ = client.InspectSandbox(ctx, id)
	_ = client.DeleteSandbox(ctx, id)
	_, _ = client.StartSandbox(ctx, id, sandbox.StartRequest{})
	_, _ = client.StopSandbox(ctx, id)
	_, _ = client.SuspendSandbox(ctx, id)
	_, _ = client.Execute(ctx, id, sandbox.ExecRequest{})
	_, _ = client.SnapshotSandbox(ctx, id, sandbox.SnapshotRequest{})
	_ = client.DeleteSnapshot(ctx, id)
	_, _ = client.CreateService(ctx, id, sandbox.ServiceSpec{})
	_, _ = client.GrantAccess(ctx, id, id, sandbox.GrantAccessRequest{})
	_, _ = client.CreateIdentityToken(ctx, id)
	_, _ = client.InspectSandbox(ctx, "..")

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{
		"/v1/sandboxes/" + escaped + "/fork|",
		"/v1/sandboxes/" + escaped + "|",
		"/v1/sandboxes/" + escaped + "|",
		"/v1/sandboxes/" + escaped + "/start|",
		"/v1/sandboxes/" + escaped + "/stop|",
		"/v1/sandboxes/" + escaped + "/suspend|",
		"/v1/sandboxes/" + escaped + "/exec|",
		"/v1/sandboxes/" + escaped + "/snapshot|",
		"/v1/sandboxes/snapshots/" + escaped + "|",
		"/v1/sandboxes/" + escaped + "/services|",
		"/v1/access/identities/" + escaped + "/permissions/sandbox/" + escaped + "|",
		"/v1/access/identities/" + escaped + "/tokens|",
		"/v1/sandboxes/%2E%2E|",
	}, paths)
}
