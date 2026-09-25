package smitherscli

import (
	"bytes"
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

func commandsRepoZServe(t *testing.T, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := repoCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("repo %v returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsRepoZServeErr(t *testing.T, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := repoCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("repo %v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsRepoZJjRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".jj"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func commandsRepoZChdir(t *testing.T, dir string) {
	t.Helper()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
}

func commandsRepoZWriteConfig(t *testing.T, dir string, body string) {
	t.Helper()
	path := filepath.Join(dir, localSmithersConfigPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsRepoZSuccessServers(t *testing.T) (*httptest.Server, *httptest.Server, *bool) {
	t.Helper()
	failAPI := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if failAPI {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"api boom"}`)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/repos":
			fmt.Fprint(w, `{"full_name":"alice/demo","description":"Demo","clone_url":"https://example.com/alice/demo.git","ssh_url":"git@example.com:alice/demo.git","private":false}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/repos":
			fmt.Fprint(w, `[{"full_name":"alice/demo","description":"Demo","private":false}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo":
			fmt.Fprint(w, `{"full_name":"alice/demo","description":"Demo","private":false}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/mirror-sync":
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"run_id":41}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/github-app-status":
			fmt.Fprint(w, `{"github_app_installed":true,"github_rate_limit_limit":100,"github_rate_limit_remaining":90}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repo-connection":
			fmt.Fprint(w, `{"connected":true}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repo-connection":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/forks":
			fmt.Fprint(w, `{"full_name":"alice/demo-fork"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/transfer":
			fmt.Fprint(w, `{"full_name":"bob/demo"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/archive":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/archive":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPut && r.URL.Path == "/api/user/starred/alice/demo":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/user/starred/alice/demo":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/subscription":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo":
			fmt.Fprint(w, `{"full_name":"alice/renamed"}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/subscription":
			fmt.Fprint(w, `{"full_name":"alice/demo","subscribed":true}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"message":"missing %s %s"}`, r.Method, r.URL.Path)
		}
	}))
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.EscapedPath() {
		case "/repos/alice/demo":
			fmt.Fprint(w, `{"private":false,"license":{"spdx_id":"MIT"}}`)
		case "/repos/alice/private":
			fmt.Fprint(w, `{"private":true,"license":{"spdx_id":"MIT"}}`)
		case "/repos/alice/gpl":
			fmt.Fprint(w, `{"private":false,"license":{"spdx_id":"GPL-3.0"}}`)
		case "/repos/alice/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	t.Cleanup(api.Close)
	t.Cleanup(github.Close)
	return api, github, &failAPI
}

func TestCommandsRepo_Z_HumanOutputAndAPIErrorBranches(t *testing.T) {
	api, github, failAPI := commandsRepoZSuccessServers(t)
	commandsRepoCovSetConfig(t, api.URL)
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	t.Setenv("GITHUB_TOKEN", "repo-z-gh")

	repoDir := commandsRepoZJjRepo(t)
	commandsRepoZChdir(t, repoDir)

	for _, argv := range [][]string{
		{"create", "demo", "--format", "toon"},
		{"create", "demo"},
		{"list"},
		{"view", "--repo", "alice/demo"},
		{"connect", "alice/demo"},
		{"status"},
		{"mirror-sync", "--repo", "alice/demo"},
		{"fork", "alice/demo"},
		{"transfer", "alice/demo", "--to", "bob"},
		{"archive", "alice/demo"},
		{"unarchive", "alice/demo"},
		{"delete", "alice/demo", "--yes"},
		{"edit", "alice/demo"},
		{"disconnect"},
	} {
		commandsRepoZServe(t, argv...)
	}

	binDir := t.TempDir()
	commandsRepoCovWriteExecutable(t, binDir, "jj", "#!/bin/sh\nif [ \"$1\" = git ] && [ \"$2\" = clone ]; then printf 'jj nope\\n' >&2; exit 4; fi\nexit 0\n")
	commandsRepoCovWriteExecutable(t, binDir, "git", "#!/bin/sh\nif [ \"$1\" = clone ]; then printf 'git cloned\\n'; exit 0; fi\nexit 9\n")
	t.Setenv("PATH", binDir)
	commandsRepoZServe(t, "clone", "alice/demo", "--directory", filepath.Join(t.TempDir(), "clone-target"), "--protocol", "https")

	*failAPI = true
	for _, tc := range []struct {
		want string
		argv []string
	}{
		{"api boom", []string{"create", "demo"}},
		{"api boom", []string{"list"}},
		{"api boom", []string{"view", "alice/demo"}},
		{"api boom", []string{"mirror-sync", "--repo", "alice/demo"}},
		{"api boom", []string{"fork", "alice/demo"}},
		{"api boom", []string{"transfer", "alice/demo", "--to", "bob"}},
		{"api boom", []string{"archive", "alice/demo"}},
		{"api boom", []string{"edit", "alice/demo"}},
	} {
		commandsRepoZServeErr(t, tc.want, tc.argv...)
	}
	commandsRepoZServeErr(t, "Invalid repo format", "view", "bad")
	commandsRepoZServeErr(t, "Repository must be in OWNER/REPO format", "mirror-sync", "--repo", "bad")
	commandsRepoZServeErr(t, "Invalid repo format", "fork", "bad")
	commandsRepoZServeErr(t, "Invalid repo format", "transfer", "bad", "--to", "bob")
	commandsRepoZServeErr(t, "Invalid repo format", "archive", "bad")
	commandsRepoZServeErr(t, "Invalid repo format", "edit", "bad")
	commandsRepoZServeErr(t, "required arguments were not provided: repo", "clone")
}

func TestCommandsRepo_Z_ConnectDisconnectStatusErrorBranches(t *testing.T) {
	api, github, failAPI := commandsRepoZSuccessServers(t)
	commandsRepoCovSetConfig(t, api.URL)
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	t.Setenv("GITHUB_TOKEN", "repo-z-gh")

	commandsRepoZChdir(t, t.TempDir())
	commandsRepoZServeErr(t, "NOT_JJ_REPO", "connect", "alice/demo")

	repoDir := commandsRepoZJjRepo(t)
	commandsRepoZChdir(t, repoDir)
	commandsRepoZServeErr(t, "OWNER/REPO", "connect", "bad")
	commandsRepoZServeErr(t, "GitHub API request failed", "connect", "alice/missing")
	commandsRepoZServeErr(t, "REPO_NOT_PUBLIC", "connect", "alice/private")
	commandsRepoZServeErr(t, "LICENSE_NOT_PERMITTED", "connect", "alice/gpl")

	*failAPI = true
	commandsRepoZServeErr(t, "api boom", "connect", "alice/demo")
	*failAPI = false

	saveErrDir := commandsRepoZJjRepo(t)
	if err := os.MkdirAll(filepath.Join(saveErrDir, localSmithersConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	commandsRepoZChdir(t, saveErrDir)
	commandsRepoZServeErr(t, "EISDIR", "connect", "alice/demo")

	commandsRepoZChdir(t, t.TempDir())
	commandsRepoZServeErr(t, "NOT_JJ_REPO", "disconnect")
	commandsRepoZServeErr(t, "NOT_JJ_REPO", "status")

	invalidConfigDir := commandsRepoZJjRepo(t)
	commandsRepoZWriteConfig(t, invalidConfigDir, "{bad-json")
	commandsRepoZChdir(t, invalidConfigDir)
	commandsRepoZServeErr(t, "Invalid .smithers/config.json", "disconnect")
	commandsRepoZServeErr(t, "Invalid .smithers/config.json", "status")

	badRepoDir := commandsRepoZJjRepo(t)
	commandsRepoZWriteConfig(t, badRepoDir, `{"repo_connection":{"connected_at":"now","license_spdx_id":"MIT","repo":"bad"}}`)
	commandsRepoZChdir(t, badRepoDir)
	commandsRepoZServeErr(t, "OWNER/REPO", "disconnect")
	commandsRepoZServeErr(t, "OWNER/REPO", "status")

	deleteErrDir := commandsRepoZJjRepo(t)
	commandsRepoZWriteConfig(t, deleteErrDir, `{"repo_connection":{"connected_at":"now","license_spdx_id":"MIT","repo":"alice/demo"}}`)
	commandsRepoZChdir(t, deleteErrDir)
	*failAPI = true
	commandsRepoZServeErr(t, "api boom", "disconnect")
	commandsRepoZServeErr(t, "api boom", "status")
	*failAPI = false

	clearErrDir := commandsRepoZJjRepo(t)
	commandsRepoZWriteConfig(t, clearErrDir, `{"repo_connection":{"connected_at":"now","license_spdx_id":"MIT","repo":"alice/demo"}}`)
	commandsRepoZChdir(t, clearErrDir)
	oldClear := clearLocalRepoConnectionForCommand
	t.Cleanup(func() { clearLocalRepoConnectionForCommand = oldClear })
	clearLocalRepoConnectionForCommand = func(string) error {
		return fmt.Errorf("clear failed")
	}
	commandsRepoZServeErr(t, "clear failed", "disconnect")
	clearLocalRepoConnectionForCommand = oldClear
}

func TestCommandsRepo_Z_HelperErrorBranches(t *testing.T) {
	if got := normalizeSpdxID(" \t "); got != "" {
		t.Fatalf("normalizeSpdxID empty = %q", got)
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", "")
	if got := githubAPIBaseURL(); got != "https://api.github.com" {
		t.Fatalf("githubAPIBaseURL default = %q", got)
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", "://bad-url")
	if _, err := fetchGithubRepo("alice", "demo"); err == nil {
		t.Fatal("fetchGithubRepo accepted invalid URL")
	}
	t.Setenv("SMITHERS_GITHUB_API_URL", "http://127.0.0.1:1")
	if _, err := fetchGithubRepo("alice", "demo"); err == nil {
		t.Fatal("fetchGithubRepo accepted transport failure")
	}

	statusCalls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/repos/alice/status/github-app-status":
			statusCalls++
			if statusCalls == 1 {
				fmt.Fprint(w, `{"github_app_installed":false,"install_url":""}`)
				return
			}
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"status failed"}`)
		case "/api/repos/alice/metadata":
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"message":"nope"}`)
		default:
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"status failed"}`)
		}
	}))
	defer api.Close()
	commandsRepoCovSetConfig(t, api.URL)
	if _, err := fetchGitHubAppStatus("alice", "missing"); err == nil || !strings.Contains(err.Error(), "status failed") {
		t.Fatalf("fetchGitHubAppStatus error = %v", err)
	}
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "1")
	if _, err := waitForGitHubAppInstallation("alice", "status", false); err == nil || !strings.Contains(err.Error(), "status failed") {
		t.Fatalf("waitForGitHubAppInstallation loop error = %v", err)
	}
	if err := maybeLookupRepoMetadata("alice", "metadata"); err != nil {
		t.Fatalf("maybeLookupRepoMetadata unauthorized = %v", err)
	}

	postFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/github-app-status"):
			fmt.Fprint(w, `{"github_app_installed":true}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repo-connection":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"message":"connect post failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing repo"}`)
		default:
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	defer postFail.Close()
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"private":false,"license":{"spdx_id":"MIT"}}`)
	}))
	defer github.Close()
	commandsRepoCovSetConfig(t, postFail.URL)
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	t.Setenv("GITHUB_TOKEN", "repo-z-gh")
	connectDir := commandsRepoZJjRepo(t)
	commandsRepoZChdir(t, connectDir)
	commandsRepoZServeErr(t, "connect post failed", "connect", "alice/demo")

	pollCalls := 0
	pollSuccess := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		pollCalls++
		if pollCalls == 1 {
			fmt.Fprint(w, `{"github_app_installed":false}`)
			return
		}
		fmt.Fprint(w, `{"github_app_installed":true}`)
	}))
	defer pollSuccess.Close()
	commandsRepoCovSetConfig(t, pollSuccess.URL)
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "1")
	if status, err := waitForGitHubAppInstallation("alice", "demo", false); err != nil || status["github_app_installed"] != true {
		t.Fatalf("waitForGitHubAppInstallation unstructured success = %#v %v", status, err)
	}

	eisDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(eisDir, localSmithersConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := readSmithersLocalConfig(eisDir); err == nil || !strings.Contains(err.Error(), "EISDIR") {
		t.Fatalf("readSmithersLocalConfig EISDIR = %v", err)
	}
	permDir := t.TempDir()
	commandsRepoZWriteConfig(t, permDir, `{"ok":true}`)
	configPath := filepath.Join(permDir, localSmithersConfigPath)
	if err := os.Chmod(configPath, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(configPath, 0o600) })
	if _, err := readSmithersLocalConfig(permDir); err == nil {
		t.Fatal("readSmithersLocalConfig accepted unreadable file")
	}

	mkdirErr := t.TempDir()
	if err := os.WriteFile(filepath.Join(mkdirErr, ".smithers"), []byte("file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSmithersLocalConfig(mkdirErr, map[string]any{}); err == nil {
		t.Fatal("writeSmithersLocalConfig accepted file parent")
	}
	if err := writeSmithersLocalConfig(t.TempDir(), map[string]any{"bad": func() {}}); err == nil {
		t.Fatal("writeSmithersLocalConfig accepted unmarshalable value")
	}
	writeEISDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(writeEISDir, localSmithersConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeSmithersLocalConfig(writeEISDir, map[string]any{}); err == nil || !strings.Contains(err.Error(), "EISDIR") {
		t.Fatalf("writeSmithersLocalConfig EISDIR = %v", err)
	}
	writePerm := t.TempDir()
	commandsRepoZWriteConfig(t, writePerm, `{"repo_connection":{"connected_at":"now","license_spdx_id":"MIT","repo":"alice/demo"}}`)
	writePath := filepath.Join(writePerm, localSmithersConfigPath)
	if err := os.Chmod(writePath, 0o400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(writePath, 0o600) })
	if err := writeSmithersLocalConfig(writePerm, map[string]any{"ok": true}); err == nil {
		t.Fatal("writeSmithersLocalConfig accepted read-only file")
	}
	commandsRepoZChdir(t, writePerm)
	commandsRepoCovSetConfig(t, postFail.URL)
	if err := clearLocalRepoConnection(writePerm); err == nil {
		t.Fatal("clearLocalRepoConnection accepted read-only config")
	}

	badConfig := t.TempDir()
	commandsRepoZWriteConfig(t, badConfig, "{bad-json")
	if err := saveLocalRepoConnection(badConfig, localRepoConnection{}); err == nil {
		t.Fatal("saveLocalRepoConnection accepted invalid config")
	}
	if err := clearLocalRepoConnection(badConfig); err == nil {
		t.Fatal("clearLocalRepoConnection accepted invalid config")
	}

	oldResolver := resolveRepoCloneTarget
	t.Cleanup(func() { resolveRepoCloneTarget = oldResolver })
	resolveRepoCloneTarget = func(repoRef string, protocol GitProtocol, apiURL string) (string, string, string, error) {
		return "", "", "", fmt.Errorf("clone target failed")
	}
	commandsRepoZServeErr(t, "clone target failed", "clone", "alice/demo")
	resolveRepoCloneTarget = oldResolver

	commandsRepoCovSetConfig(t, postFail.URL)
	commandsRepoZServeErr(t, "missing repo", "clone", "alice/missing")
	binDir := t.TempDir()
	commandsRepoCovWriteExecutable(t, binDir, "jj", "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", binDir)
	commandsRepoZServe(t, "clone", "localrepo")

	badAPIConfig := t.TempDir()
	configHome := filepath.Join(badAPIConfig, "config")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: \"://bad-url\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_TOKEN", "repo-z-token")
	if err := maybeLookupRepoMetadata("alice", "demo"); err != nil {
		t.Fatalf("maybeLookupRepoMetadata non-API error = %v", err)
	}

	if got := githubAppPollInterval(); got <= 0 {
		t.Fatalf("githubAppPollInterval = %s", got)
	}
	_ = time.Second
	_ = json.Valid
}
