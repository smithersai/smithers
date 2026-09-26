package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
	"github.com/stretchr/testify/require"
)

func TestAdminCommandRequests(t *testing.T) {
	// Expectations are independent of the command registry: each method, route,
	// query, body, and Observe confirmation target is part of the wire contract.
	cases := []struct{ command, method, path, query, body, confirm string }{
		{"status", "GET", "/api/admin/system/status", "", "", ""},
		{"incidents list --state open --policy Production --limit 50", "GET", "/api/admin/system/incidents", "limit=50&policy=Production&state=open", "", ""},
		{"incidents ack 229 --note checked", "POST", "/api/admin/system/incidents/229/acknowledge", "", `{"note":"checked"}`, ""},
		{"incidents unack 229", "POST", "/api/admin/system/incidents/229/unacknowledge", "", "", ""},
		{"incidents resolve 229 --note fixed --yes", "POST", "/api/admin/system/incidents/229/resolve", "", `{"note":"fixed"}`, ""},
		{"incidents snooze 229 --until 2026-09-14T01:00:00Z", "POST", "/api/admin/system/incidents/229/snooze", "", `{"until":"2026-09-14T01:00:00Z"}`, ""},
		{"incidents bulk --action resolve --ids 229,230 --note fixed --yes", "POST", "/api/admin/system/incidents/bulk", "", `{"action":"resolve","ids":[229,230],"note":"fixed"}`, ""},
		{"incidents bulk --action snooze --policy Production --until 2026-09-14T01:00:00Z --yes", "POST", "/api/admin/system/incidents/bulk", "", `{"action":"snooze","policy":"Production","until":"2026-09-14T01:00:00Z"}`, ""},
		{"analytics summary --range 30d --include-synthetic", "GET", "/api/admin/analytics/summary", "include_synthetic=true&range=30d", "", ""},
		{"sessions list --status active", "GET", "/api/admin/agent-sessions", "include_synthetic=false&status=active", "", ""},
		{"sessions cancel abc --reason stuck --yes", "POST", "/api/admin/agent-sessions/abc/cancel", "", `{"reason":"stuck"}`, ""},
		{"workspaces list --status failed --kind container --owner alice", "GET", "/api/admin/workspaces", "include_synthetic=false&kind=container&owner=alice&status=failed", "", ""},
		{"workspaces stop abc --yes", "POST", "/api/admin/workspaces/abc/stop", "", "", ""},
		{"workspaces suspend abc --yes", "POST", "/api/admin/workspaces/abc/suspend", "", "", ""},
		{"hosts list", "GET", "/api/admin/sandbox/hosts", "", "", ""},
		{"hosts drain abc --yes", "POST", "/api/admin/sandbox/hosts/abc/drain", "", "", ""},
		{"hosts prune-stale --older-than-hours 48 --yes", "POST", "/api/admin/sandbox/hosts/prune-stale", "", `{"older_than_hours":48}`, ""},
		{"tokens list --unused-days 30 --scope write:admin --expiring-days 2 --limit 50", "GET", "/api/admin/tokens", "expiring_days=2&limit=50&scope=write%3Aadmin&unused_days=30", "", ""},
		{"users set-synthetic alice --value true", "PATCH", "/api/admin/users/alice", "", `{"synthetic":true}`, ""},
		{"users set-synthetic alice --value false", "PATCH", "/api/admin/users/alice", "", `{"synthetic":false}`, ""},
		{"metrics query --name http_request_rate --range 1h", "GET", "/api/admin/system/metrics/query", "name=http_request_rate&range=1h", "", ""},
		{"audit list --since 2026-09-13", "GET", "/api/admin/audit-logs", "since=2026-09-13", "", ""},
		{"alerts channels list", "GET", "/api/v1/alerts/channels", "", "", ""},
		{"alerts channels add --type email --display-name Primary --target ops@example.com --route critical", "POST", "/api/v1/alerts/channels", "", `{"type":"email","display_name":"Primary","target":"ops@example.com","route":"critical"}`, "Primary"},
		{"alerts channels remove abc --yes", "DELETE", "/api/v1/alerts/channels/abc", "", "", "abc"},
		{"alerts channels send-code abc", "POST", "/api/v1/alerts/channels/abc/send-code", "", "", "abc"},
		{"alerts channels verify abc --code 001234", "POST", "/api/v1/alerts/channels/abc/verify", "", `{"code":"001234"}`, "abc"},
		{"alerts channels set-route abc --route all", "PATCH", "/api/v1/alerts/channels/abc", "", `{"route":"all"}`, "abc"},
		{"alerts policies list", "GET", "/api/v1/alerts/policies", "", "", ""},
		{"alerts policies enable abc", "PATCH", "/api/v1/alerts/policies/abc", "", `{"enabled":true}`, "abc"},
		{"alerts policies disable abc", "PATCH", "/api/v1/alerts/policies/abc", "", `{"enabled":false}`, "abc"},
		{"deploys observe list", "GET", "/api/v1/deploys/observe", "", "", ""},
		{"deploys observe rollback abc --yes", "POST", "/api/v1/deploys/observe/abc/rollback", "", "", "abc"},
		{"deploys observe redeploy abc --yes", "POST", "/api/v1/deploys/observe/abc/redeploy", "", "", "abc"},
		{"deploys observe restart abc --yes", "POST", "/api/v1/deploys/observe/abc/restart", "", "", "abc"},
		{"deploys platform list", "GET", "/api/v1/deploys/platform", "", "", ""},
		{"deploys platform rollback server --revision 42 --yes", "POST", "/api/v1/deploys/platform/server/rollback", "", `{"revision":"42"}`, "server"},
		{"deploys platform status server", "GET", "/api/v1/deploys/platform/server/status", "", "", ""},
		{"runs list --repo alice/demo", "GET", "/api/repos/alice/demo/workflows/runs", "page=1&per_page=30", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			requests := 0
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				require.Equal(t, tc.method, r.Method)
				require.Equal(t, tc.path, r.URL.Path)
				require.Equal(t, tc.query, r.URL.RawQuery)
				require.Equal(t, "token smithers_contract", r.Header.Get("Authorization"))
				require.Equal(t, "application/json", r.Header.Get("Accept"))
				require.Equal(t, tc.confirm, r.Header.Get("X-Confirm"))
				raw, err := io.ReadAll(r.Body)
				require.NoError(t, err)
				if tc.body == "" {
					require.Empty(t, string(raw))
					require.Empty(t, r.Header.Get("Content-Type"))
				} else {
					require.JSONEq(t, tc.body, string(raw))
					require.Equal(t, "application/json", r.Header.Get("Content-Type"))
				}
				if tc.method == "DELETE" {
					w.WriteHeader(204)
					return
				}
				fmt.Fprint(w, `{"id":"9007199254740993","status":"ok"}`)
			})
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.False(t, strings.HasPrefix(r.URL.Path, "/api/v1/"))
				handler.ServeHTTP(w, r)
			}))
			defer api.Close()
			observe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.True(t, strings.HasPrefix(r.URL.Path, "/api/v1/"))
				handler.ServeHTTP(w, r)
			}))
			defer observe.Close()
			authFSetConfig(t, api.URL)
			t.Setenv("SMITHERS_TOKEN", "smithers_contract")
			require.NoError(t, SaveConfig(map[string]string{"observe_url": observe.URL}))
			output := commandsMoreHTTPHServe(t, adminCommand(), append(strings.Fields(tc.command), "--json")...)
			require.Equal(t, 1, requests)
			if tc.method != "DELETE" {
				require.Contains(t, output, "9007199254740993")
			}
		})
	}
}

func TestAdminDestructiveConfirmation(t *testing.T) {
	commands := []string{"sessions cancel abc", "workspaces stop abc", "workspaces suspend abc", "hosts drain abc", "hosts prune-stale", "incidents resolve 1", "incidents bulk --action resolve --policy Production", "alerts channels remove abc", "deploys observe rollback abc", "deploys observe redeploy abc", "deploys observe restart abc", "deploys platform rollback server --revision 42"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unconfirmed request reached server") }))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "smithers_contract")
	require.NoError(t, SaveConfig(map[string]string{"observe_url": server.URL}))
	old := adminIsTerminal
	adminIsTerminal = func(int) bool { return false }
	defer func() { adminIsTerminal = old }()
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			commandsMoreHTTPHServeWantErr(t, adminCommand(), "requires --yes", strings.Fields(command)...)
		})
	}
}

func TestAdminConfirmationPrompt(t *testing.T) {
	old := adminIsTerminal
	adminIsTerminal = func(int) bool { return true }
	defer func() { adminIsTerminal = old }()
	for _, tc := range []struct {
		input    string
		approved bool
	}{{"yes\n", true}, {"Y\n", true}, {"no\n", false}, {"\n", false}, {"", false}} {
		t.Run(fmt.Sprintf("%q", tc.input), func(t *testing.T) {
			commandsMoreHTTPHWithStdin(t, tc.input, func() {
				err := confirmDestructiveOperation(false, "cancel abc")
				if tc.approved {
					require.NoError(t, err)
				} else {
					require.Error(t, err)
				}
			})
		})
	}
}

func TestAdminInvalidArguments(t *testing.T) {
	for _, command := range []string{
		"incidents bulk --action resolve --yes", "incidents bulk --action resolve --ids 1 --policy X --yes", "incidents bulk --action resolve --ids 1,no --yes", "incidents bulk --action snooze --ids 1 --yes", "incidents bulk --action delete --ids 1 --yes", "users set-synthetic alice --value maybe", "deploys platform rollback ../server --revision 1 --yes",
	} {
		t.Run(command, func(t *testing.T) {
			var out bytes.Buffer
			require.Error(t, adminCommand().ServeWithOptions(strings.Fields(command), incur.ServeOptions{Stdout: &out}))
		})
	}
}

func TestAdminOutputFormats(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"incidents":[{"id":229,"state":"open"}]}`)
	}))
	defer server.Close()
	authFSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "smithers_contract")
	old := adminIsTerminal
	defer func() { adminIsTerminal = old }()
	for _, human := range []bool{false, true} {
		adminIsTerminal = func(int) bool { return human }
		var out bytes.Buffer
		require.NoError(t, adminCommand().ServeWithOptions([]string{"incidents", "list"}, incur.ServeOptions{Stdout: &out, Human: &human}))
		if human {
			require.Contains(t, out.String(), "state")
			require.Contains(t, out.String(), "---")
		} else {
			var parsed any
			require.NoError(t, json.Unmarshal(out.Bytes(), &parsed))
		}
	}
	require.Equal(t, "Completed", formatAdminResult(nil))
	require.Equal(t, "No results", formatAdminResult([]any{}))
	require.Contains(t, formatAdminResult(map[string]any{"ok": true}), "Field")
}
