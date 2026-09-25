package smitherscli

import (
	"net/http"
	"net/http/httptest"
	"testing"

	incur "github.com/smithersai/incur"
	"github.com/stretchr/testify/require"
)

// Deletes of users, repositories, and workspaces are irreversible, and the CLI
// also runs as an MCP tool server, so a non-TTY caller must pass --yes.
func TestDestructiveDeletesRequireConfirmation(t *testing.T) {
	cases := []struct {
		name string
		cli  func() *incur.Cli
		argv []string
		path string
	}{
		{"admin user delete", adminCommand, []string{"user", "delete", "bob"}, "/api/admin/users/bob"},
		{"repo delete", repoCommand, []string{"delete", "alice/demo"}, "/api/repos/alice/demo"},
		{"workspace delete", workspaceCommand, []string{"delete", "ws-1", "--repo", "alice/demo"}, "/api/repos/alice/demo/workspaces/ws-1"},
	}
	old := adminIsTerminal
	adminIsTerminal = func(int) bool { return false }
	defer func() { adminIsTerminal = old }()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deletes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, http.MethodDelete, r.Method)
				require.Equal(t, tc.path, r.URL.Path)
				deletes++
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			commandsMoreHTTPHSetConfig(t, server.URL)

			commandsMoreHTTPHServeWantErr(t, tc.cli(), "requires --yes when stdin is not a TTY", tc.argv...)
			require.Zero(t, deletes, "unconfirmed delete reached the server")

			commandsMoreHTTPHServe(t, tc.cli(), append(tc.argv, "--yes", "--json")...)
			require.Equal(t, 1, deletes)
		})
	}
}
