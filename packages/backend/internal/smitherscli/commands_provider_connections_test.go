package smitherscli

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func providerTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(raw) + ".sig"
}

func writeProviderFixture(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeLocalLoginImportsSubscriptionCredentials(t *testing.T) {
	dir := t.TempDir()
	writeProviderFixture(t, dir, ".credentials.json", `{"claudeAiOauth":{"accessToken":"sk-ant-oat-access","refreshToken":"sk-ant-ort-refresh","expiresAt":1767225600000,"subscriptionType":"max"}}`)
	writeProviderFixture(t, dir, ".claude.json", `{"oauthAccount":{"emailAddress":"dev@example.com"}}`)

	got, err := claudeLocalLogin(dir)
	if err != nil {
		t.Fatal(err)
	}
	wantExpiry := time.UnixMilli(1767225600000).UTC()
	if got.Provider != "claude" || got.Kind != "oauth" || got.AccessToken != "sk-ant-oat-access" || got.RefreshToken != "sk-ant-ort-refresh" ||
		got.Plan != "max" || got.AccountEmail != "dev@example.com" || got.AccessExpiresAt == nil || !got.AccessExpiresAt.Equal(wantExpiry) {
		t.Fatalf("claude payload = %#v", got)
	}

	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if fromEnv, err := claudeLocalLogin(""); err != nil || fromEnv.AccessToken != "sk-ant-oat-access" {
		t.Fatalf("CLAUDE_CONFIG_DIR login = %#v, %v", fromEnv, err)
	}

	apiKeyOnly := t.TempDir()
	writeProviderFixture(t, apiKeyOnly, ".credentials.json", `{"primaryApiKey":"sk-ant-api"}`)
	if _, err := claudeLocalLogin(apiKeyOnly); err == nil || !strings.Contains(err.Error(), "not a subscription login") {
		t.Fatalf("api-key-only login error = %v", err)
	}
}

func TestCodexLocalLoginImportsChatGPTCredentials(t *testing.T) {
	dir := t.TempDir()
	idToken := providerTestJWT(t, map[string]any{
		"email":                       "dev@example.com",
		"https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "pro", "chatgpt_account_id": "acct-from-id-token"},
	})
	accessToken := providerTestJWT(t, map[string]any{"exp": 1767225600})
	auth, _ := json.Marshal(map[string]any{
		"auth_mode": "chatgpt",
		"tokens":    map[string]any{"id_token": idToken, "access_token": accessToken, "refresh_token": "rt-codex"},
	})
	writeProviderFixture(t, dir, "auth.json", string(auth))

	got, err := codexLocalLogin(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != "codex" || got.Kind != "oauth" || got.AccessToken != accessToken || got.RefreshToken != "rt-codex" ||
		got.AccountEmail != "dev@example.com" || got.Plan != "pro" || got.AccountID != "acct-from-id-token" ||
		got.AccessExpiresAt == nil || !got.AccessExpiresAt.Equal(time.Unix(1767225600, 0).UTC()) {
		t.Fatalf("codex payload = %#v", got)
	}

	explicitAccount := t.TempDir()
	auth, _ = json.Marshal(map[string]any{"tokens": map[string]any{"id_token": idToken, "access_token": "opaque", "refresh_token": "rt", "account_id": "acct-explicit"}})
	writeProviderFixture(t, explicitAccount, "auth.json", string(auth))
	if got, err := codexLocalLogin(explicitAccount); err != nil || got.AccountID != "acct-explicit" || got.AccessExpiresAt != nil {
		t.Fatalf("explicit account login = %#v, %v", got, err)
	}

	apiKeyOnly := t.TempDir()
	writeProviderFixture(t, apiKeyOnly, "auth.json", `{"OPENAI_API_KEY":"sk-proj"}`)
	if _, err := codexLocalLogin(apiKeyOnly); err == nil || !strings.Contains(err.Error(), "not a ChatGPT subscription login") {
		t.Fatalf("api-key-only login error = %v", err)
	}
	t.Setenv("CODEX_HOME", t.TempDir())
	if _, err := codexLocalLogin(""); err == nil || !strings.Contains(err.Error(), "run `codex login`") {
		t.Fatalf("missing login error = %v", err)
	}
}

func TestJWTPayloadClaimsRejectsMalformedTokens(t *testing.T) {
	for _, token := range []string{"", "no-dots", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte("not json")) + ".c"} {
		if claims := jwtPayloadClaims(token); claims != nil {
			t.Fatalf("jwtPayloadClaims(%q) = %#v", token, claims)
		}
	}
	padded := "a." + base64.URLEncoding.EncodeToString([]byte(`{"sub":"x"}`)) + ".c"
	if claims := jwtPayloadClaims(padded); claims["sub"] != "x" {
		t.Fatalf("padded token claims = %#v", claims)
	}
}

func TestProviderConnectionCommandsCallTheConnectionsAPI(t *testing.T) {
	var posted []providerConnectPayload
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/provider-connections":
			var body providerConnectPayload
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode connect body: %v", err)
			}
			posted = append(posted, body)
			fmt.Fprintf(w, `{"id":"conn-%d","provider":%q}`, len(posted), body.Provider)
		case "GET /api/user/provider-connections", "GET /api/orgs/acme/provider-connections":
			fmt.Fprint(w, `[{"id":"conn-1","provider":"claude"}]`)
		case "DELETE /api/user/provider-connections/conn-1":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsLandCovSetConfig(t, server.URL)

	claudeDir := t.TempDir()
	writeProviderFixture(t, claudeDir, ".credentials.json", `{"claudeAiOauth":{"accessToken":"sk-ant-oat-access","refreshToken":"sk-ant-ort-refresh"}}`)
	codexDir := t.TempDir()
	writeProviderFixture(t, codexDir, "auth.json", `{"tokens":{"access_token":"at-codex","refresh_token":"rt-codex"}}`)

	cli := func() *incur.Cli {
		cmd := incur.New("auth")
		registerProviderConnectionCommands(cmd)
		return cmd
	}
	commandsLandCovServe(t, cli(), []string{"connect", "Claude", "--config-dir", claudeDir, "--label", "work"})
	commandsLandCovServe(t, cli(), []string{"connect", "codex", "--config-dir", codexDir})
	if len(posted) != 2 {
		t.Fatalf("connect requests = %d", len(posted))
	}
	if posted[0].Provider != "claude" || posted[0].Kind != "oauth" || posted[0].AccessToken != "sk-ant-oat-access" || posted[0].RefreshToken != "sk-ant-ort-refresh" || posted[0].Label != "work" {
		t.Fatalf("claude connect body = %#v", posted[0])
	}
	if posted[1].Provider != "codex" || posted[1].AccessToken != "at-codex" || posted[1].RefreshToken != "rt-codex" {
		t.Fatalf("codex connect body = %#v", posted[1])
	}

	if got := commandsLandCovServe(t, cli(), []string{"connections", "--org", "acme"}); !strings.Contains(got, "conn-1") {
		t.Fatalf("connections output = %q", got)
	}
	commandsLandCovServe(t, cli(), []string{"connections"})
	if got := commandsLandCovServe(t, cli(), []string{"revoke", "conn-1"}); !strings.Contains(got, "revoked") {
		t.Fatalf("revoke output = %q", got)
	}

	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"connect", "gemini"}, "provider must be claude or codex"},
		{[]string{"connect", "codex", "--config-dir", t.TempDir()}, "run `codex login`"},
		{[]string{"revoke", " "}, "connection id is required"},
	} {
		var stdout bytes.Buffer
		err := cli().ServeWithOptions(tc.argv, incur.ServeOptions{Stdout: &stdout})
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v error = %v, want %q", tc.argv, err, tc.want)
		}
	}

	want := []string{
		"POST /api/user/provider-connections",
		"POST /api/user/provider-connections",
		"GET /api/orgs/acme/provider-connections",
		"GET /api/user/provider-connections",
		"DELETE /api/user/provider-connections/conn-1",
	}
	if strings.Join(seen, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests = %v, want %v", seen, want)
	}
}

// A deployment with subscription connections off (the hosted product) answers
// the feature gate's 403; every command says the feature is unavailable
// instead of surfacing a raw HTTP error, and connect never offers --org.
func TestProviderConnectionCommandsReportUnavailableFeature(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":"feature not available"}`)
	}))
	defer server.Close()
	commandsLandCovSetConfig(t, server.URL)
	claudeDir := t.TempDir()
	writeProviderFixture(t, claudeDir, ".credentials.json", `{"claudeAiOauth":{"accessToken":"sk-ant-oat-access","refreshToken":"sk-ant-ort-refresh"}}`)

	for _, argv := range [][]string{
		{"connect", "claude", "--config-dir", claudeDir},
		{"connections"},
		{"revoke", "conn-1"},
	} {
		cmd := incur.New("auth")
		registerProviderConnectionCommands(cmd)
		var stdout bytes.Buffer
		err := cmd.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
		if err == nil || !strings.Contains(err.Error(), "subscription connections are not available on this deployment") {
			t.Fatalf("%v error = %v", argv, err)
		}
	}
}
