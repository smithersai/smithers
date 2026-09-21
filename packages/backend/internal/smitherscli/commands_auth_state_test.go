package smitherscli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func authZCallbackState(t *testing.T, loginURL string) string {
	t.Helper()
	parsed, err := url.Parse(loginURL)
	require.NoError(t, err)
	return parsed.Query().Get("callback_state")
}

func TestBrowserLoginCallbackState(t *testing.T) {
	states := map[string]bool{}
	for _, admin := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "admin"}[admin], func(t *testing.T) {
			commandsAuthCovSetConfig(t, "https://api.example.test")
			authZWithOpenBrowser(t, func(loginURL string) error {
				state := authZCallbackState(t, loginURL)
				require.Len(t, state, 43)
				nonce, err := base64.RawURLEncoding.DecodeString(state)
				require.NoError(t, err)
				require.Len(t, nonce, 32)
				require.False(t, states[state], "each login needs a fresh nonce")
				states[state] = true
				start, err := url.Parse(loginURL)
				require.NoError(t, err)
				if admin {
					require.Equal(t, "1", start.Query().Get("admin"))
				}
				callbackURL := authZCallbackURL(t, loginURL)
				for _, forged := range []string{"", strings.Repeat("A", 43)} {
					resp := authZPostJSON(t, callbackURL, map[string]string{
						"token": "smithers_attacker", "expires_at": "2099-01-01T00:00:00Z",
						"callback_state": forged,
					})
					require.Equal(t, http.StatusForbidden, resp.StatusCode)
					require.NoError(t, resp.Body.Close())
				}
				// Rejected callbacks must leave the listener available for this login.
				resp := authZPostJSON(t, callbackURL, map[string]string{
					"token": "smithers_legitimate", "expires_at": "2099-01-01T00:00:00Z",
					"callback_state": state,
				})
				require.Equal(t, http.StatusOK, resp.StatusCode)
				return resp.Body.Close()
			})
			result, err := runBrowserLogin(map[string]string{"admin": map[bool]string{false: "false", true: "true"}[admin]})
			require.NoError(t, err)
			require.Equal(t, "smithers_legitimate", result.Token)
		})
	}
}

// Execute the actual bridge JavaScript with a navigated fragment. The fragment
// never reaches the GET handler; the script's same-origin JSON POST must still
// prove possession of the state before the CLI accepts a credential.
func TestBrowserLoginRejectsForgedFragmentNavigation(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("bun is required to execute the browser bridge JavaScript")
	}
	for _, admin := range []string{"false", "true"} {
		t.Run("admin="+admin, func(t *testing.T) {
			commandsAuthCovSetConfig(t, "https://api.example.test")
			authZWithOpenBrowser(t, func(loginURL string) error {
				callbackURL := authZCallbackURL(t, loginURL)
				resp, err := http.Get(callbackURL)
				require.NoError(t, err)
				page, err := io.ReadAll(resp.Body)
				require.NoError(t, err)
				require.NoError(t, resp.Body.Close())
				state := authZCallbackState(t, loginURL)
				require.NotContains(t, string(page), state, "public bridge must not disclose the expected state")
				_, script, ok := strings.Cut(string(page), "<script>")
				require.True(t, ok)
				script, _, ok = strings.Cut(script, "</script>")
				require.True(t, ok)
				for _, test := range []struct{ state, token, status string }{
					{"", "smithers_attacker", "403"},
					{strings.Repeat("A", 43), "smithers_attacker", "403"},
					{state, "smithers_legitimate", "200"},
				} {
					fragment := url.Values{"token": {test.token}, "expires_at": {"2099-01-01T00:00:00Z"}}
					if test.state != "" {
						fragment.Set("callback_state", test.state)
					}
					input, err := json.Marshal(map[string]string{"script": script, "hash": "#" + fragment.Encode(), "url": callbackURL})
					require.NoError(t, err)
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					cmd := exec.CommandContext(ctx, bun, "-e", `
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
await vm.runInNewContext(input.script, {
  URLSearchParams,
  window: {location: {hash: input.hash}},
  document: {open(){}, write(){}, close(){}, body:{}},
  fetch: async (path, options) => {
    const response = await fetch(new URL(path, input.url), options);
    console.log(response.status);
    return response;
  }
});
`)
					cmd.Stdin = strings.NewReader(string(input))
					output, err := cmd.CombinedOutput()
					cancel()
					require.NoError(t, err, string(output))
					require.Equal(t, test.status, strings.TrimSpace(string(output)))
				}
				return nil
			})
			result, err := runBrowserLogin(map[string]string{"admin": admin})
			require.NoError(t, err)
			require.Equal(t, "smithers_legitimate", result.Token)
		})
	}
}
