package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsAuthCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	setTestCredentialStoreFile(t, filepath.Join(root, "credentials.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(root, "config", "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCommandsAuth_Cov_CommandHelpAndStatusFormatting(t *testing.T) {
	for _, cli := range []*incur.Cli{authCommand(), claudeAuthCommand()} {
		var stdout bytes.Buffer
		if err := cli.ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
			t.Fatalf("help returned error: %v", err)
		}
		if stdout.Len() == 0 {
			t.Fatal("expected help output")
		}
	}

	status := AuthStatusResult{
		LoggedIn: true, APIURL: "https://api.example", Host: "example", TokenSet: true,
		TokenSource: AuthTokenSourceEnv, User: "alice", Username: "alice-login", Email: "alice@example.test",
		ExpiresAt: "2026-01-02T03:04:05Z", Message: "ready",
	}
	out := formatAuthStatus(status)
	for _, want := range []string{
		"logged_in: true",
		"api_url: \"https://api.example\"",
		"token_source: \"SMITHERS_TOKEN env\"",
		"user: \"alice\"",
		"username: \"alice-login\"",
		"email: \"alice@example.test\"",
		"expires_at: \"2026-01-02T03:04:05Z\"",
		"message: \"ready\"",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("formatAuthStatus missing %q:\n%s", want, out)
		}
	}
}

func TestCommandsAuth_Cov_TokenValidationAndJWTDetection(t *testing.T) {
	for _, tc := range []struct {
		name    string
		input   string
		want    string
		wantErr string
	}{
		{name: "smithers token", input: "  smithers_abc  ", want: "smithers_abc"},
		{name: "jwt", input: "abc.DEF_123.ghi-456", want: "abc.DEF_123.ghi-456"},
		{name: "blank", input: " \n ", wantErr: "no token"},
		{name: "invalid", input: "plain-token", wantErr: "Invalid token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := validateToken(tc.input)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("validateToken error = %v, want contains %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("validateToken = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	if !isLikelyJWT("abc.DEF_123.ghi-456") {
		t.Fatal("expected valid JWT shape")
	}
	for _, token := range []string{"a.b", "a..c", "a.b.c!", "a.b.c.d"} {
		if isLikelyJWT(token) {
			t.Fatalf("expected %q to be rejected as JWT", token)
		}
	}
}

func TestCommandsAuth_Cov_ClaudeSetupValidationAndResolution(t *testing.T) {
	commandsAuthCovSetConfig(t, "https://api.example.test")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")

	token, err := validateClaudeSetupToken("paste sk-ant-oat01-test_Value.more now")
	if err != nil || token != "sk-ant-oat01-test_Value.more" {
		t.Fatalf("validateClaudeSetupToken extracted %q, %v", token, err)
	}
	for _, input := range []string{"", "not a setup token"} {
		if _, err := validateClaudeSetupToken(input); err == nil {
			t.Fatalf("expected validation error for %q", input)
		}
	}

	if resolved := resolveClaudeAuth(); resolved != nil {
		t.Fatalf("expected no Claude auth, got %#v", resolved)
	}
	if _, err := getResolvedClaudeAuthToken(); err == nil || !strings.Contains(err.Error(), "no Claude Code auth found") {
		t.Fatalf("expected missing Claude auth guidance, got %v", err)
	}
	if !strings.Contains(describeClaudeAuthAvailability(), "claude setup-token") {
		t.Fatal("availability message should mention setup-token")
	}

	if err := StoreToken(claudeSetupTokenStorageKey, "stored-token"); err != nil {
		t.Fatalf("StoreToken returned error: %v", err)
	}
	resolved := resolveClaudeAuth()
	if resolved == nil || resolved.Source != "stored Claude subscription token" || resolved.EnvKey != "ANTHROPIC_AUTH_TOKEN" || resolved.Token != "stored-token" {
		t.Fatalf("stored Claude token resolution = %#v", resolved)
	}
	t.Setenv("ANTHROPIC_API_KEY", "api-key")
	resolved = resolveClaudeAuth()
	if resolved == nil || resolved.Token != "stored-token" {
		t.Fatalf("stored token should win over API key, got %#v", resolved)
	}
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-token")
	resolved = resolveClaudeAuth()
	if resolved == nil || resolved.Source != "ANTHROPIC_AUTH_TOKEN env" || resolved.Token != "env-token" {
		t.Fatalf("auth token env should win, got %#v", resolved)
	}
	DeleteStoredToken(claudeSetupTokenStorageKey)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	resolved = resolveClaudeAuth()
	if resolved == nil || resolved.Source != "ANTHROPIC_API_KEY env" || resolved.Token != "api-key" {
		t.Fatalf("API key fallback = %#v", resolved)
	}
}

func TestCommandsAuth_Cov_PushClaudeSecret(t *testing.T) {
	var secretPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/repos/alice/demo/secrets" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "token smithers_auth_cov_token" {
			t.Fatalf("Authorization header = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&secretPayload); err != nil {
			t.Fatalf("invalid secret JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	commandsAuthCovSetConfig(t, server.URL)
	t.Setenv("SMITHERS_TOKEN", "smithers_auth_cov_token")

	pushed, err := pushClaudeAuthSecret("alice/demo", &resolvedClaudeToken{EnvKey: "ANTHROPIC_AUTH_TOKEN", Source: "test source", Token: "secret-token"})
	if err != nil {
		t.Fatalf("pushClaudeAuthSecret returned error: %v", err)
	}
	if pushed["repo"] != "alice/demo" || pushed["secret_name"] != "ANTHROPIC_AUTH_TOKEN" || secretPayload["value"] != "secret-token" {
		t.Fatalf("push result = %#v payload = %#v", pushed, secretPayload)
	}
}

func TestCommandsAuth_Cov_BrowserFetchHelpersAndHTML(t *testing.T) {
	setTestBrowserFetch(t, true)
	var posted map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			http.Redirect(w, r, "/callback#token=smithers_cb&username=alice&email=a%40example.test&expires_at=soon", http.StatusFound)
		case "/callback":
			if r.Method != http.MethodPost {
				t.Fatalf("callback method = %s", r.Method)
			}
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Fatalf("invalid callback JSON: %v", err)
			}
			w.WriteHeader(http.StatusNoContent)
		case "/ok":
			fmt.Fprint(w, "ok")
		case "/fail":
			http.Error(w, "no", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected browser helper path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	if err := fetchBrowserLoginURL(server.URL + "/login"); err != nil {
		t.Fatalf("fetchBrowserLoginURL redirect callback returned error: %v", err)
	}
	if posted["token"] != "smithers_cb" || posted["username"] != "alice" || posted["email"] != "a@example.test" {
		t.Fatalf("callback payload = %#v", posted)
	}
	if err := openBrowser(server.URL + "/ok"); err != nil {
		t.Fatalf("openBrowser fetch mode returned error: %v", err)
	}
	if err := fetchBrowserLoginURL(server.URL + "/fail"); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected fetch failure, got %v", err)
	}

	candidates := browserCandidates("https://login.example")
	if len(candidates) == 0 || candidates[0][len(candidates[0])-1] != "https://login.example" {
		t.Fatalf("browserCandidates(%s) = %#v on %s", "https://login.example", candidates, runtime.GOOS)
	}
	escaped := escapeHTML(`<tag attr="x">&'`)
	if escaped != "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;" {
		t.Fatalf("escapeHTML = %q", escaped)
	}
	if html := successHTML("api.example", `<alice>`); !strings.Contains(html, "&lt;alice&gt;") || strings.Contains(html, "<alice>") {
		t.Fatalf("successHTML did not escape username:\n%s", html)
	}
	if html := callbackBridgeHTML(`api."example"`); !strings.Contains(html, "api.&quot;example&quot;") || !strings.Contains(html, "fetch('/callback'") {
		t.Fatalf("callbackBridgeHTML unexpected:\n%s", html)
	}
}

func TestCommandsAuth_Cov_RunBrowserLoginSuccess(t *testing.T) {
	var authRequests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/github/cli" {
			t.Fatalf("unexpected auth path: %s", r.URL.Path)
		}
		authRequests++
		port := r.URL.Query().Get("callback_port")
		if port == "" {
			t.Fatal("callback_port query was empty")
		}
		target := "http://127.0.0.1:" + port + "/callback#token=smithers_browser&username=bob&email=bob%40example.test&expires_at=2026&callback_state=" + r.URL.Query().Get("callback_state")
		http.Redirect(w, r, target, http.StatusFound)
	}))
	defer server.Close()
	commandsAuthCovSetConfig(t, server.URL)
	setTestBrowserFetch(t, true)

	result, err := runBrowserLogin(nil)
	if err != nil {
		t.Fatalf("runBrowserLogin returned error: %v", err)
	}
	if result.Token != "smithers_browser" || result.Username != "bob" || result.Email != "bob@example.test" || result.Host == "" {
		t.Fatalf("browser login result = %#v", result)
	}
	if authRequests != 1 {
		t.Fatalf("authRequests = %d", authRequests)
	}
}
