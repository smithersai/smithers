package ssh

import (
	"context"
	"fmt"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestProxyReceivePack_Shallow(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		ref     string
		wantErr string
	}{
		{name: "forwards unchanged", ref: "refs/heads/feature"},
		{name: "protected second command", ref: "refs/heads/main", wantErr: "protected bookmark"},
		{name: "reserved second command", ref: "refs/smithers/private", wantErr: "reserved ref"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			packet := func(line string) string { return fmt.Sprintf("%04x%s", len(line)+4, line) }
			const oid = "340ecc0ee56893ec516de12e72468ffe9a2886f0"
			const next = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
			input := packet("shallow "+oid+"\n") +
				packet(oid+" "+next+" refs/heads/first\x00report-status side-band-64k") +
				packet("shallow "+next+"\n") + packet(oid+" "+next+" "+tc.ref) + "0000PACK\x00\xff"
			called := false
			server := &Server{
				Queries: &mockSSHPrincipalQuerier{
					getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
						return db.Repository{ID: 1}, nil
					},
					listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
						return []db.ProtectedBookmark{{Pattern: "main"}}, nil
					},
				},
				RepoHostClient: &mockRepoHostGitProxy{
					infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
					proxyReceivePackFn: func(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, meta ...repohost.ReceivePackMetadata) error {
						called = true
						body, err := io.ReadAll(stdin)
						require.NoError(t, err)
						assert.Equal(t, input, string(body))
						require.Len(t, meta, 1)
						assert.Equal(t, int64(42), meta[0].PusherID)
						return nil
					},
				},
			}
			sess := newTestSession("git-receive-pack 'alice/demo.git'", input)
			err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", sshPrincipal{UserID: 42, Username: "alice"})
			if tc.wantErr != "" {
				require.ErrorContains(t, err, tc.wantErr)
				assert.False(t, called)
			} else {
				require.NoError(t, err)
				assert.True(t, called)
			}
		})
	}
}
