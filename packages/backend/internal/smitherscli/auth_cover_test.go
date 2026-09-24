package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func authCovSetConfig(t *testing.T, apiURL string) string {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	setTestCredentialStoreFile(t, filepath.Join(root, "credentials.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestAuth_Cov_TargetResolutionAndFormatting(t *testing.T) {
	for _, host := range []string{"localhost:8080", "127.0.0.1", "127.99.1.2", "[::1]:3000", "::1"} {
		if !isLoopbackHost(host) {
			t.Fatalf("isLoopbackHost(%q) = false", host)
		}
	}
	if isLoopbackHost("api.example.com") {
		t.Fatal("isLoopbackHost accepted api.example.com")
	}

	for _, tc := range []struct {
		input string
		want  string
	}{
		{" https://api.example.com/api/ ", "https://api.example.com"},
		{"localhost:9000", "http://localhost:9000"},
		{"example.com", "https://api.example.com"},
		{"api.custom.test", "https://api.custom.test"},
	} {
		got, err := apiURLFromHostInput(tc.input)
		if err != nil || got != tc.want {
			t.Fatalf("apiURLFromHostInput(%q) = %q, %v; want %q", tc.input, got, err, tc.want)
		}
	}
	if _, err := apiURLFromHostInput(" \t "); err == nil || !strings.Contains(err.Error(), "Hostname is required") {
		t.Fatalf("apiURLFromHostInput blank error = %v", err)
	}

	authCovSetConfig(t, "https://api.config.test/api")
	target, err := ResolveAuthTarget(nil)
	if err != nil || target.APIURL != "https://api.config.test" || target.Host != "config.test" {
		t.Fatalf("ResolveAuthTarget default = %#v, %v", target, err)
	}
	target, err = ResolveAuthTarget(map[string]string{"apiUrl": "http://localhost:7777/api"})
	if err != nil || target.APIURL != "http://localhost:7777" || target.Host != "localhost" {
		t.Fatalf("ResolveAuthTarget apiUrl = %#v, %v", target, err)
	}
	target, err = ResolveAuthTarget(map[string]string{"hostname": "config.test"})
	if err != nil || target.APIURL != "https://api.config.test" || target.Host != "config.test" {
		t.Fatalf("ResolveAuthTarget configured hostname = %#v, %v", target, err)
	}
	target, err = ResolveAuthTarget(map[string]string{"hostname": "other.test"})
	if err != nil || target.APIURL != "https://api.other.test" || target.Host != "other.test" {
		t.Fatalf("ResolveAuthTarget other hostname = %#v, %v", target, err)
	}
	target, err = ResolveAuthTarget(map[string]string{"hostname": "https://custom.test/api"})
	if err != nil || target.APIURL != "https://custom.test" || target.Host != "custom.test" {
		t.Fatalf("ResolveAuthTarget URL hostname = %#v, %v", target, err)
	}

	for _, tc := range []struct {
		source AuthTokenSource
		want   string
	}{
		{AuthTokenSourceEnv, "SMITHERS_TOKEN env"},
		{AuthTokenSourceKeyring, "keyring"},
		{AuthTokenSourceSmithersAuthFile, "~/.config/smithers/auth.json"},
		{AuthTokenSourceConfig, "config file"},
		{AuthTokenSource("custom"), "custom"},
	} {
		if got := FormatTokenSource(tc.source); got != tc.want {
			t.Fatalf("FormatTokenSource(%q) = %q", tc.source, got)
		}
	}
	if got := firstNonEmpty("", " \t ", "value", "later"); got != "value" {
		t.Fatalf("firstNonEmpty = %q", got)
	}
}

func TestAuth_Cov_FileLegacyAndTokenResolution(t *testing.T) {
	root := authCovSetConfig(t, "https://api.example.test")
	target, err := ResolveAuthTarget(nil)
	if err != nil {
		t.Fatal(err)
	}

	record, err := readSmithersAuthFile()
	if err != nil || record != nil {
		t.Fatalf("readSmithersAuthFile missing = %#v, %v", record, err)
	}
	if err := writeSmithersAuthFile(target, "file-token", authTokenMetadata{Username: " alice ", Email: " a@example.test ", ExpiresAt: " soon "}); err != nil {
		t.Fatalf("writeSmithersAuthFile returned error: %v", err)
	}
	record, err = readSmithersAuthFile()
	if err != nil || record == nil || record.Token != "file-token" || record.Username != "alice" || record.Email != "a@example.test" || record.ExpiresAt != "soon" || record.UpdatedAt == "" {
		t.Fatalf("readSmithersAuthFile written = %#v, %v", record, err)
	}
	if got := readSmithersAuthTokenForTarget(target); got != "file-token" {
		t.Fatalf("readSmithersAuthTokenForTarget = %q", got)
	}
	if other := readSmithersAuthRecordForTarget(AuthTarget{APIURL: "https://api.other.test", Host: "other.test"}); other != nil {
		t.Fatalf("readSmithersAuthRecordForTarget other host = %#v", other)
	}
	if clearSmithersAuthFile("other.test") {
		t.Fatal("clearSmithersAuthFile cleared a different host")
	}
	if !clearSmithersAuthFile(target.Host) {
		t.Fatal("clearSmithersAuthFile did not clear target host")
	}
	if clearSmithersAuthFile(target.Host) {
		t.Fatal("clearSmithersAuthFile reported clearing missing file")
	}

	if err := os.WriteFile(smithersAuthFilePath(), []byte("{bad-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSmithersAuthFile(); err == nil {
		t.Fatal("readSmithersAuthFile accepted invalid JSON")
	}
	if got := readSmithersAuthRecordForTarget(target); got != nil {
		t.Fatalf("readSmithersAuthRecordForTarget invalid JSON = %#v", got)
	}
	if err := os.Remove(smithersAuthFilePath()); err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(root, "config", "smithers", "config.toon")
	if err := os.WriteFile(configPath, []byte("api_url: https://api.example.test\ntoken: legacy-token\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readLegacyTokenForTarget(target); got != "legacy-token" {
		t.Fatalf("readLegacyTokenForTarget = %q", got)
	}
	if got := readLegacyTokenForTarget(AuthTarget{APIURL: "https://api.other.test", Host: "other.test"}); got != "" {
		t.Fatalf("readLegacyTokenForTarget other host = %q", got)
	}
	if !scrubLegacyTokenIfCurrentHost(target) {
		t.Fatal("scrubLegacyTokenIfCurrentHost did not clear token")
	}
	if scrubLegacyTokenIfCurrentHost(target) {
		t.Fatal("scrubLegacyTokenIfCurrentHost reported clearing twice")
	}

	t.Setenv("SMITHERS_TOKEN", "env-token")
	resolved, err := ResolveAuthToken(nil)
	if err != nil || resolved == nil || resolved.Source != AuthTokenSourceEnv || resolved.Token != "env-token" {
		t.Fatalf("ResolveAuthToken env = %#v, %v", resolved, err)
	}
	t.Setenv("SMITHERS_TOKEN", "")
	if err := StoreToken(target.Host, "keyring-token"); err != nil {
		t.Fatalf("StoreToken returned error: %v", err)
	}
	resolved, err = ResolveAuthToken(nil)
	if err != nil || resolved == nil || resolved.Source != AuthTokenSourceKeyring || resolved.Token != "keyring-token" {
		t.Fatalf("ResolveAuthToken keyring = %#v, %v", resolved, err)
	}
	if !DeleteStoredToken(target.Host) {
		t.Fatal("DeleteStoredToken failed before file-token branch")
	}
	if err := writeSmithersAuthFile(target, "file-token", authTokenMetadata{}); err != nil {
		t.Fatal(err)
	}
	resolved, err = ResolveAuthToken(nil)
	if err != nil || resolved == nil || resolved.Source != AuthTokenSourceSmithersAuthFile || resolved.Token != "file-token" {
		t.Fatalf("ResolveAuthToken auth file = %#v, %v", resolved, err)
	}
	if err := os.Remove(smithersAuthFilePath()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("api_url: https://api.example.test\ntoken: legacy-token\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resolved, err = ResolveAuthToken(nil)
	if err != nil || resolved == nil || resolved.Source != AuthTokenSourceConfig || resolved.Token != "legacy-token" {
		t.Fatalf("ResolveAuthToken legacy = %#v, %v", resolved, err)
	}
	if _, err := RequireAuthToken(map[string]string{"hostname": "missing.test"}); err == nil || !strings.Contains(err.Error(), "no token found for missing.test") {
		t.Fatalf("RequireAuthToken missing error = %v", err)
	}
}

func TestAuth_Cov_PersistClearAndStatus(t *testing.T) {
	var statusCode = http.StatusOK
	var seenAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/user" {
			t.Fatalf("unexpected auth status path: %s", r.URL.Path)
		}
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		if statusCode >= 200 && statusCode < 300 {
			fmt.Fprint(w, `{"login":"server-user","email":"server@example.test"}`)
		} else {
			fmt.Fprint(w, `{"message":"bad token"}`)
		}
	}))
	defer server.Close()

	authCovSetConfig(t, "https://api.old.test")
	target, err := PersistAuthToken(" stored-token \n", map[string]string{
		"apiUrl":    server.URL,
		"username":  "stored-user",
		"email":     "stored@example.test",
		"expiresAt": "2027-01-02T03:04:05Z",
	})
	if err != nil {
		t.Fatalf("PersistAuthToken returned error: %v", err)
	}
	if target.APIURL != server.URL || target.Host == "" {
		t.Fatalf("PersistAuthToken target = %#v", target)
	}
	if got, _ := LoadStoredToken(target.Host); got != "stored-token" {
		t.Fatalf("PersistAuthToken keyring token = %q", got)
	}
	record, err := readSmithersAuthFile()
	if err != nil || record == nil || record.Token != "" || record.Username != "stored-user" {
		t.Fatalf("PersistAuthToken auth file = %#v, %v", record, err)
	}
	if cfg := mustLoadConfig(t); cfg.APIURL != server.URL {
		t.Fatalf("PersistAuthToken saved config APIURL = %#v", cfg)
	}

	status := GetAuthStatus(server.Client(), map[string]string{"apiUrl": server.URL})
	if !status.LoggedIn || !status.TokenSet || status.Username != "server-user" || status.Email != "server@example.test" || status.TokenSource != AuthTokenSourceKeyring {
		t.Fatalf("GetAuthStatus success = %#v", status)
	}
	if seenAuth != "token stored-token" {
		t.Fatalf("status Authorization header = %q", seenAuth)
	}

	statusCode = http.StatusUnauthorized
	status = GetAuthStatus(server.Client(), map[string]string{"apiUrl": server.URL})
	if status.LoggedIn || !status.TokenSet || !strings.Contains(status.Message, "invalid or expired") || status.Username != "stored-user" {
		t.Fatalf("GetAuthStatus invalid token = %#v", status)
	}

	result, err := ClearAuthToken(map[string]string{"apiUrl": server.URL})
	if err != nil || !result.Cleared || result.Host != target.Host {
		t.Fatalf("ClearAuthToken = %#v, %v", result, err)
	}
	status = GetAuthStatus(server.Client(), map[string]string{"apiUrl": server.URL})
	if status.LoggedIn || status.TokenSet || !strings.Contains(status.Message, "Not logged in") {
		t.Fatalf("GetAuthStatus missing token = %#v", status)
	}

	t.Setenv("SMITHERS_TOKEN", "env-status-token")
	statusCode = http.StatusOK
	status = GetAuthStatus(server.Client(), map[string]string{"apiUrl": server.URL})
	if !status.LoggedIn || status.TokenSource != AuthTokenSourceEnv || status.Username != "server-user" {
		encoded, _ := json.Marshal(status)
		t.Fatalf("GetAuthStatus env token = %s", encoded)
	}
}
