package services

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestGitHTTPProxyService_ReceivePack_Shallow(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		ref    string
		denied bool
	}{
		{name: "forwards unchanged", ref: "refs/heads/feature"},
		{name: "protected second command", ref: "refs/heads/main", denied: true},
		{name: "reserved second command", ref: "refs/smithers/private", denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, repoHost := newReservedRefProxy(t, "write:repository")
			svc.queries.(*mockGitHTTPProxyQuerier).listAllProtectedBookmarksFn = func(context.Context, int64) ([]db.ProtectedBookmark, error) {
				return []db.ProtectedBookmark{{Pattern: "main"}}, nil
			}
			const shallow = "shallow 340ecc0ee56893ec516de12e72468ffe9a2886f0\n"
			input := fmt.Sprintf("%04x%s", len(shallow)+4, shallow) + receivePackBody("refs/heads/first", tc.ref).String()
			repoHost.proxyReceiveFn = func(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, _ ...repohost.ReceivePackMetadata) error {
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, input, string(body))
				return nil
			}
			err := svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", strings.NewReader(input), io.Discard)
			if tc.denied {
				require.Error(t, err)
				assert.Equal(t, 403, apiStatus(t, err))
				assert.Zero(t, repoHost.receivePackCall)
			} else {
				require.NoError(t, err)
				assert.Equal(t, 1, repoHost.receivePackCall)
			}
		})
	}
}
