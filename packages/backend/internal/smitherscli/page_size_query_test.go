package smitherscli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
	"github.com/stretchr/testify/require"
)

// Page-numbered list commands must send the page size as per_page. The server
// treats any `page` parameter as legacy pagination, which reads only
// page/per_page, so a `limit` sent beside `page` is ignored: the page size
// stays at 30 and `--page 2 --limit 10` returns rows 31-60.
func TestPageNumberedCommandsSendPageSizeAsPerPage(t *testing.T) {
	cases := []struct {
		name string
		cli  func() *incur.Cli
		argv string
		path string
	}{
		{"search repos", searchCommand, "repos bug --page 2 --limit 10", "/api/search/repositories"},
		{"search issues", searchCommand, "issues bug --page 2 --limit 10", "/api/search/issues"},
		{"search code", searchCommand, "code bug --page 2 --limit 10", "/api/search/code"},
		{"search users", searchCommand, "users bug --page 2 --limit 10", "/api/search/users"},
		{"admin user list", adminCommand, "user list --page 2 --limit 10", "/api/admin/users"},
		{"admin runs list", adminCommand, "runs list --repo alice/demo --page 2 --limit 10", "/api/repos/alice/demo/workflows/runs"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				require.Equal(t, tc.path, r.URL.Path)
				query := r.URL.Query()
				require.Equal(t, "2", query.Get("page"), "raw query %s", r.URL.RawQuery)
				require.Equal(t, "10", query.Get("per_page"), "raw query %s", r.URL.RawQuery)
				require.False(t, query.Has("limit"), "limit beside page is ignored by the server: %s", r.URL.RawQuery)
				fmt.Fprint(w, `[]`)
			}))
			defer server.Close()
			authFSetConfig(t, server.URL)
			t.Setenv("SMITHERS_TOKEN", "smithers_page_size")
			commandsMoreHTTPHServe(t, tc.cli(), append(strings.Fields(tc.argv), "--json")...)
			require.Equal(t, 1, requests)
		})
	}
}
