package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func commandsRepoCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	setTestCredentialStoreFile(t, filepath.Join(root, "credentials.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "commands_repo_cov_token")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsRepoCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsRepoCovRequireSeen(t *testing.T, seen []string, want string) {
	t.Helper()
	for _, got := range seen {
		if strings.HasPrefix(got, want) {
			return
		}
	}
	t.Fatalf("server did not see %q; saw %v", want, seen)
}

func commandsRepoCovChdir(t *testing.T, dir string) {
	t.Helper()
	oldwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(oldwd)
	})
}

func commandsRepoCovWriteExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func commandsRepoCovCaptureStderr(t *testing.T, fn func()) string {
	t.Helper()
	oldStderr := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writer
	defer func() {
		os.Stderr = oldStderr
		_ = reader.Close()
	}()
	fn()
	_ = writer.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, reader); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

func TestCommandsRepo_Cov_CommandHandlersMutationsAndClone(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_repo_cov_token" {
			t.Errorf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/repos":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "demo" || body["description"] != "Demo repo" || body["private"] != true {
				t.Errorf("repo create body = %#v", body)
			}
			fmt.Fprint(w, `{"full_name":"alice/demo","private":true}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/repos":
			if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("per_page") != "5" {
				t.Errorf("repo list query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"full_name":"alice/demo"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo":
			fmt.Fprint(w, `{"full_name":"alice/demo","private":false}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/mirror-sync":
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"run_id":41}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/forks":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "forked" || body["organization"] != "acme" {
				t.Errorf("fork body = %#v", body)
			}
			fmt.Fprint(w, `{"full_name":"acme/forked"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/transfer":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["new_owner"] != "acme" {
				t.Errorf("transfer body = %#v", body)
			}
			fmt.Fprint(w, `{"full_name":"acme/demo"}`)
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
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/subscription":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["subscribed"] != false || body["ignored"] != true || body["reason"] != "ignored" {
				t.Errorf("watch body = %#v", body)
			}
			fmt.Fprint(w, `{"subscribed":false}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/subscription":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["description"] != "" || body["private"] != false || body["name"] != "demo-renamed" {
				t.Errorf("edit body = %#v", body)
			}
			fmt.Fprint(w, `{"full_name":"alice/demo-renamed"}`)
		default:
			t.Errorf("unexpected repo command request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsRepoCovSetConfig(t, server.URL)

	commandsRepoCovServe(t, repoCommand(), []string{"create", "demo", "--description", "Demo repo", "--private", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"list", "--page", "2", "--limit", "5", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"view", "alice/demo", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"mirror-sync", "--repo", "alice/demo", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"fork", "alice/demo", "--name", "forked", "--organization", "acme", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"transfer", "alice/demo", "--to", "acme", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"archive", "alice/demo", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"unarchive", "alice/demo", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"delete", "alice/demo", "--json"})
	commandsRepoCovServe(t, repoCommand(), []string{"edit", "alice/demo", "--description", "", "--private=false", "--name", "demo-renamed", "--json"})

	for _, expected := range []string{
		"POST /api/user/repos",
		"GET /api/user/repos",
		"POST /api/repos/alice/demo/forks",
		"POST /api/repos/alice/demo/transfer",
		"PATCH /api/repos/alice/demo",
	} {
		commandsRepoCovRequireSeen(t, seen, expected)
	}

	successBin := t.TempDir()
	commandsRepoCovWriteExecutable(t, successBin, "jj", "#!/bin/sh\nif [ \"$1\" = git ] && [ \"$2\" = clone ]; then printf 'jj cloned\\n'; exit 0; fi\nexit 9\n")
	commandsRepoCovWriteExecutable(t, successBin, "git", "#!/bin/sh\nprintf 'git should not run\\n' >&2\nexit 9\n")
	t.Setenv("PATH", successBin)
	cloneTarget := filepath.Join(t.TempDir(), "demo")
	cloneOut := commandsRepoCovServe(t, repoCommand(), []string{"clone", "https://example.com/alice/demo.git", "--directory", cloneTarget, "--protocol", "https", "--json"})
	if !strings.Contains(cloneOut, `"tool": "jj"`) || !strings.Contains(cloneOut, cloneTarget) {
		t.Fatalf("clone success output = %s", cloneOut)
	}

	failBin := t.TempDir()
	commandsRepoCovWriteExecutable(t, failBin, "jj", "#!/bin/sh\nprintf 'jj failed\\n' >&2\nexit 11\n")
	commandsRepoCovWriteExecutable(t, failBin, "git", "#!/bin/sh\nprintf 'git failed\\n'\nexit 12\n")
	t.Setenv("PATH", failBin)
	var stdout bytes.Buffer
	stderr := commandsRepoCovCaptureStderr(t, func() {
		err := repoCommand().ServeWithOptions([]string{"clone", "https://example.com/alice/demo.git", "--directory", filepath.Join(t.TempDir(), "demo")}, incur.ServeOptions{Stdout: &stdout})
		if err == nil || !strings.Contains(err.Error(), "Clone failed with jj and git") || !strings.Contains(err.Error(), "jj failed") || !strings.Contains(err.Error(), "git failed") {
			t.Fatalf("clone failure error = %v stdout=%s", err, stdout.String())
		}
	})
	if !strings.Contains(stderr, "jj failed") || !strings.Contains(stderr, "git failed") {
		t.Fatalf("clone failure logs = %q", stderr)
	}
}

func TestCommandsRepo_Cov_ConnectStatusDisconnectWorkflow(t *testing.T) {
	var apiSeen []string
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiSeen = append(apiSeen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_repo_cov_token" {
			t.Errorf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/github-app-status":
			fmt.Fprint(w, `{"github_app_installed":true,"github_rate_limit_limit":5000,"github_rate_limit_remaining":4999,"github_rate_limit_reset":"2026-09-02T13:00:00Z"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repo-connection":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["owner"] != "alice" || body["repo"] != "demo" || body["license_spdx_id"] != "MIT" {
				t.Errorf("repo connection body = %#v", body)
			}
			fmt.Fprint(w, `{"connected":true}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repo-connection":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected connect API request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer apiServer.Close()

	githubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/repos/alice/demo" {
			t.Fatalf("unexpected GitHub path: %s", r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer gh-token" {
			t.Fatalf("GitHub Authorization header = %q", got)
		}
		if got := r.Header.Get("User-Agent"); !strings.HasPrefix(got, "smithers-cli/") {
			t.Fatalf("GitHub User-Agent = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"private":false,"license":{"spdx_id":"NOASSERTION"}}`)
	}))
	defer githubServer.Close()

	commandsRepoCovSetConfig(t, apiServer.URL)
	t.Setenv("SMITHERS_GITHUB_API_URL", githubServer.URL)
	t.Setenv("GITHUB_TOKEN", "gh-token")

	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, ".jj"), 0o755); err != nil {
		t.Fatal(err)
	}
	mitText := "MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy without limitation the rights to use, copy, modify.\n"
	if err := os.WriteFile(filepath.Join(cwd, "LICENSE"), []byte(mitText), 0o644); err != nil {
		t.Fatal(err)
	}
	commandsRepoCovChdir(t, cwd)

	connectOut := commandsRepoCovServe(t, repoCommand(), []string{"connect", "alice/demo", "--json"})
	if !strings.Contains(connectOut, `"connected": true`) || !strings.Contains(connectOut, `"license_spdx_id": "MIT"`) {
		t.Fatalf("connect output = %s", connectOut)
	}
	current, err := localRepoConnectionFor(cwd)
	if err != nil || current == nil || current.Repo != "alice/demo" || current.LicenseSPDXID != "MIT" {
		t.Fatalf("local connection after connect = %#v, %v", current, err)
	}

	statusOut := commandsRepoCovServe(t, repoCommand(), []string{"status", "--json"})
	if !strings.Contains(statusOut, `"connected": true`) ||
		!strings.Contains(statusOut, `"github_rate_limit_remaining": 4999`) ||
		!strings.Contains(statusOut, `"github_rate_limit_reset": "2026-09-02T13:00:00Z"`) {
		t.Fatalf("status output = %s", statusOut)
	}
	disconnectOut := commandsRepoCovServe(t, repoCommand(), []string{"disconnect", "--json"})
	if !strings.Contains(disconnectOut, `"connected": false`) {
		t.Fatalf("disconnect output = %s", disconnectOut)
	}
	current, err = localRepoConnectionFor(cwd)
	if err != nil || current != nil {
		t.Fatalf("local connection after disconnect = %#v, %v", current, err)
	}
	commandsRepoCovRequireSeen(t, apiSeen, "POST /api/repo-connection")
	commandsRepoCovRequireSeen(t, apiSeen, "DELETE /api/repo-connection")

	emptyRepo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(emptyRepo, ".jj"), 0o755); err != nil {
		t.Fatal(err)
	}
	commandsRepoCovChdir(t, emptyRepo)
	if out := commandsRepoCovServe(t, repoCommand(), []string{"status"}); !strings.Contains(out, "connected: false") {
		t.Fatalf("empty repo status output = %q", out)
	}
	if out := commandsRepoCovServe(t, repoCommand(), []string{"disconnect", "--json"}); !strings.Contains(out, `"connected": false`) {
		t.Fatalf("empty repo disconnect output = %q", out)
	}
}

func TestCommandsRepo_Cov_LocalConfigLicenseAndPureHelpers(t *testing.T) {
	for _, tc := range []struct {
		name string
		want string
	}{
		{"archive", "Archive a repository"},
		{"unarchive", "Unarchive a repository"},
		{"delete", "Delete a repository"},
		{"unknown", "Update repository"},
	} {
		if got := repoMutationDescription(tc.name); got != tc.want {
			t.Fatalf("repoMutationDescription(%q) = %q", tc.name, got)
		}
	}
	if !isOwnerRepoRef("alice/demo") || isOwnerRepoRef("alice/demo/extra") {
		t.Fatal("isOwnerRepoRef classification failed")
	}
	if owner, repo, err := parseOwnerRepoRefOrThrow(" alice/demo "); err != nil || owner != "alice" || repo != "demo" {
		t.Fatalf("parseOwnerRepoRefOrThrow valid = %s/%s, %v", owner, repo, err)
	}
	if _, _, err := parseOwnerRepoRefOrThrow("bad"); err == nil || !strings.Contains(err.Error(), "OWNER/REPO") {
		t.Fatalf("parseOwnerRepoRefOrThrow invalid error = %v", err)
	}
	if err := requireJjRepoDirectory(t.TempDir()); err == nil || err.Error() != "NOT_JJ_REPO" {
		t.Fatalf("requireJjRepoDirectory missing = %v", err)
	}
	jjDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(jjDir, ".jj"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := requireJjRepoDirectory(jjDir); err != nil {
		t.Fatalf("requireJjRepoDirectory valid returned error: %v", err)
	}

	if got := normalizeSpdxID(" apache-2.0 "); got != "Apache-2.0" {
		t.Fatalf("normalizeSpdxID = %q", got)
	}
	if got := normalizeSpdxID("Custom-1.0"); got != "Custom-1.0" {
		t.Fatalf("normalizeSpdxID custom = %q", got)
	}
	if !isPermittedLicense("mit") || isPermittedLicense("GPL-3.0") {
		t.Fatal("isPermittedLicense classification failed")
	}
	if !isUnresolvedGitHubLicense(" noassertion ") || !isUnresolvedGitHubLicense("NONE") || isUnresolvedGitHubLicense("MIT") {
		t.Fatal("isUnresolvedGitHubLicense classification failed")
	}

	mitLicenseText := "MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy without limitation the rights to use, copy, modify."
	licenseCases := map[string]string{
		"// SPDX-License-Identifier: apache-2.0": "Apache-2.0",
		mitLicenseText:                           "MIT",
		"Apache License\nVersion 2.0":            "Apache-2.0",
		"Mozilla Public License, v. 2.0":         "MPL-2.0",
		"Permission to use, copy, modify, and/or distribute this software for any purpose":                                                                "ISC",
		"Redistribution and use in source and binary forms are permitted. Neither the name may be used.":                                                  "BSD-3-Clause",
		"Redistribution and use in source and binary forms are permitted. This software is provided by the copyright holders and contributors \"as is\".": "BSD-2-Clause",
	}
	for text, want := range licenseCases {
		if got := detectLicenseFromText(text); got != want {
			t.Fatalf("detectLicenseFromText(%q) = %q, want %q", text, got, want)
		}
	}
	if got := detectLicenseFromText("all rights reserved"); got != "" {
		t.Fatalf("detectLicenseFromText unknown = %q", got)
	}

	licenseDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(licenseDir, "LICENSE.md"), []byte(mitLicenseText), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readFallbackLicenseFromRepoRoot(licenseDir); got != "MIT" {
		t.Fatalf("readFallbackLicenseFromRepoRoot = %q", got)
	}
	if got := readFallbackLicenseFromRepoRoot(t.TempDir()); got != "" {
		t.Fatalf("readFallbackLicenseFromRepoRoot empty = %q", got)
	}
	if got, err := resolveRepoLicense(t.TempDir(), map[string]any{"license": map[string]any{"spdx_id": "mit"}}); err != nil || got != "MIT" {
		t.Fatalf("resolveRepoLicense GitHub MIT = %q, %v", got, err)
	}
	if _, err := resolveRepoLicense(t.TempDir(), map[string]any{"license": map[string]any{"spdx_id": "GPL-3.0"}}); err == nil || err.Error() != "LICENSE_NOT_PERMITTED" {
		t.Fatalf("resolveRepoLicense disallowed error = %v", err)
	}
	if got, err := resolveRepoLicense(licenseDir, map[string]any{"license": map[string]any{"spdx_id": "NOASSERTION"}}); err != nil || got != "MIT" {
		t.Fatalf("resolveRepoLicense fallback = %q, %v", got, err)
	}
	if _, err := resolveRepoLicense(t.TempDir(), map[string]any{"license": map[string]any{"spdx_id": "NONE"}}); err == nil || err.Error() != "LICENSE_NOT_PERMITTED" {
		t.Fatalf("resolveRepoLicense missing fallback error = %v", err)
	}

	t.Setenv("SMITHERS_GITHUB_API_URL", "http://github.example/api/")
	if got := githubAPIBaseURL(); got != "http://github.example/api" {
		t.Fatalf("githubAPIBaseURL override = %q", got)
	}
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "")
	if got := githubAppPollInterval(); got != defaultGitHubAppPollInterval {
		t.Fatalf("githubAppPollInterval default = %s", got)
	}
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "bad")
	if got := githubAppPollInterval(); got != defaultGitHubAppPollInterval {
		t.Fatalf("githubAppPollInterval invalid = %s", got)
	}
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "7")
	if got := githubAppPollInterval(); got != 7*time.Millisecond {
		t.Fatalf("githubAppPollInterval parsed = %s", got)
	}
	status := defaultGitHubAppStatus()
	if status["github_app_installed"] != false || status["install_url"] != defaultGitHubAppInstallURL {
		t.Fatalf("defaultGitHubAppStatus = %#v", status)
	}

	configDir := t.TempDir()
	config, err := readSmithersLocalConfig(configDir)
	if err != nil || len(config) != 0 {
		t.Fatalf("readSmithersLocalConfig missing = %#v, %v", config, err)
	}
	if err := writeSmithersLocalConfig(configDir, map[string]any{"keep": "value"}); err != nil {
		t.Fatalf("writeSmithersLocalConfig returned error: %v", err)
	}
	config, err = readSmithersLocalConfig(configDir)
	if err != nil || config["keep"] != "value" {
		t.Fatalf("readSmithersLocalConfig written = %#v, %v", config, err)
	}
	connection := localRepoConnection{ConnectedAt: "2026-01-02T03:04:05Z", LicenseSPDXID: "MIT", Repo: "alice/demo"}
	if err := saveLocalRepoConnection(configDir, connection); err != nil {
		t.Fatalf("saveLocalRepoConnection returned error: %v", err)
	}
	current, err := localRepoConnectionFor(configDir)
	if err != nil || current == nil || current.Repo != "alice/demo" || current.LicenseSPDXID != "MIT" {
		t.Fatalf("localRepoConnectionFor = %#v, %v", current, err)
	}
	if err := clearLocalRepoConnection(configDir); err != nil {
		t.Fatalf("clearLocalRepoConnection returned error: %v", err)
	}
	current, err = localRepoConnectionFor(configDir)
	if err != nil || current != nil {
		t.Fatalf("localRepoConnectionFor after clear = %#v, %v", current, err)
	}
	if err := clearLocalRepoConnection(configDir); err != nil {
		t.Fatalf("clearLocalRepoConnection missing returned error: %v", err)
	}

	invalidDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(invalidDir, ".smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(invalidDir, localSmithersConfigPath), []byte("{bad-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readSmithersLocalConfig(invalidDir); err == nil || !strings.Contains(err.Error(), "Invalid .smithers/config.json") {
		t.Fatalf("readSmithersLocalConfig invalid error = %v", err)
	}
	nullDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(nullDir, ".smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nullDir, localSmithersConfigPath), []byte("null"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readSmithersLocalConfig(nullDir); err == nil || !strings.Contains(err.Error(), "Invalid .smithers/config.json") {
		t.Fatalf("readSmithersLocalConfig null error = %v", err)
	}
	incompleteDir := t.TempDir()
	if err := writeSmithersLocalConfig(incompleteDir, map[string]any{"repo_connection": map[string]any{"repo": "alice/demo"}}); err != nil {
		t.Fatal(err)
	}
	if current, err := localRepoConnectionFor(incompleteDir); err != nil || current != nil {
		t.Fatalf("localRepoConnectionFor incomplete = %#v, %v", current, err)
	}
}

func TestCommandsRepo_Cov_HTTPPollingMetadataRollbackAndProgramHelpers(t *testing.T) {
	var seen []string
	statusCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/github-app-status":
			statusCalls++
			if statusCalls == 1 {
				fmt.Fprint(w, `{"github_app_installed":false,"github_rate_limit_remaining":3}`)
				return
			}
			fmt.Fprint(w, `{"github_app_installed":true,"github_rate_limit_limit":10,"github_rate_limit_remaining":9}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/present":
			fmt.Fprint(w, `{"full_name":"alice/present"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/forbidden":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"forbidden"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing repo"}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repo-connection":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected helper API request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsRepoCovSetConfig(t, server.URL)

	status, err := fetchGitHubAppStatus("alice", "demo")
	if err != nil || status["github_app_installed"] != false || status["install_url"] != defaultGitHubAppInstallURL || intValue(status["github_rate_limit_remaining"], 0) != 3 {
		t.Fatalf("fetchGitHubAppStatus = %#v, %v", status, err)
	}
	t.Setenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS", "1")
	status, err = waitForGitHubAppInstallation("alice", "demo", true)
	if err != nil || status["github_app_installed"] != true || intValue(status["github_rate_limit_limit"], 0) != 10 {
		t.Fatalf("waitForGitHubAppInstallation = %#v, %v", status, err)
	}

	t.Setenv("SMITHERS_TOKEN", "")
	if err := maybeLookupRepoMetadata("alice", "present"); err != nil {
		t.Fatalf("maybeLookupRepoMetadata without auth returned error: %v", err)
	}
	t.Setenv("SMITHERS_TOKEN", "commands_repo_cov_token")
	if err := maybeLookupRepoMetadata("alice", "present"); err != nil {
		t.Fatalf("maybeLookupRepoMetadata present returned error: %v", err)
	}
	if err := maybeLookupRepoMetadata("alice", "forbidden"); err != nil {
		t.Fatalf("maybeLookupRepoMetadata forbidden returned error: %v", err)
	}
	if err := maybeLookupRepoMetadata("alice", "missing"); err == nil || !strings.Contains(err.Error(), "missing repo") {
		t.Fatalf("maybeLookupRepoMetadata missing error = %v", err)
	}

	rollbackDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rollbackDir, ".jj"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := saveLocalRepoConnection(rollbackDir, localRepoConnection{ConnectedAt: "now", LicenseSPDXID: "MIT", Repo: "alice/demo"}); err != nil {
		t.Fatal(err)
	}
	rollbackRepoConnection(rollbackDir, "alice", "demo")
	if current, err := localRepoConnectionFor(rollbackDir); err != nil || current != nil {
		t.Fatalf("rollback local connection = %#v, %v", current, err)
	}
	commandsRepoCovRequireSeen(t, seen, "DELETE /api/repo-connection")

	githubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer gh-token" {
			t.Errorf("GitHub Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.EscapedPath() {
		case "/repos/space%20owner/demo.repo":
			fmt.Fprint(w, `{"private":false,"license":{"spdx_id":"MIT"}}`)
		case "/repos/alice/missing":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		case "/repos/alice/bad-json":
			fmt.Fprint(w, `{bad-json`)
		default:
			t.Errorf("unexpected GitHub helper path: %s", r.URL.EscapedPath())
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer githubServer.Close()
	t.Setenv("SMITHERS_GITHUB_API_URL", githubServer.URL+"/")
	t.Setenv("GITHUB_TOKEN", "gh-token")
	repo, err := fetchGithubRepo("space owner", "demo.repo")
	if err != nil || objectValue(repo["license"])["spdx_id"] != "MIT" {
		t.Fatalf("fetchGithubRepo success = %#v, %v", repo, err)
	}
	if _, err := fetchGithubRepo("alice", "missing"); err == nil || !strings.Contains(err.Error(), "GitHub API request failed") {
		t.Fatalf("fetchGithubRepo status error = %v", err)
	}
	if _, err := fetchGithubRepo("alice", "bad-json"); err == nil {
		t.Fatal("fetchGithubRepo accepted invalid JSON")
	}

	binDir := t.TempDir()
	success := commandsRepoCovWriteExecutable(t, binDir, "clone-success", "#!/bin/sh\nprintf 'out text\\n'\nprintf 'err text\\n' >&2\nexit 0\n")
	result := runCloneProgram(success, []string{"arg"})
	if result.exitCode != 0 || result.stdout != "out text\n" || result.stderr != "err text\n" {
		t.Fatalf("runCloneProgram success = %#v", result)
	}
	failure := commandsRepoCovWriteExecutable(t, binDir, "clone-failure", "#!/bin/sh\nprintf 'bad\\n' >&2\nexit 5\n")
	result = runCloneProgram(failure, nil)
	if result.exitCode != 5 || result.stderr != "bad\n" {
		t.Fatalf("runCloneProgram failure = %#v", result)
	}
	result = runCloneProgram(filepath.Join(binDir, "missing-command"), nil)
	if result.exitCode != 127 {
		t.Fatalf("runCloneProgram missing = %#v", result)
	}

	var buf bytes.Buffer
	writeWithTrailingNewline(&buf, "")
	writeWithTrailingNewline(&buf, "first")
	writeWithTrailingNewline(&buf, "second\n")
	if got := buf.String(); got != "first\nsecond\n" {
		t.Fatalf("writeWithTrailingNewline output = %q", got)
	}
	if got := cloneErrorText(cloneProgramResult{stderr: "err"}); got != "err" {
		t.Fatalf("cloneErrorText stderr = %q", got)
	}
	if got := cloneErrorText(cloneProgramResult{stdout: "out"}); got != "out" {
		t.Fatalf("cloneErrorText stdout = %q", got)
	}
	if got := cloneErrorText(cloneProgramResult{exitCode: 127}); got != "exit code 127" {
		t.Fatalf("cloneErrorText code = %q", got)
	}
	structured := cloneResult("alice", "demo", "target", GitProtocolSSH, "jj", &incur.CommandContext{FormatExplicit: true})
	if objectValue(structured)["cloned"] != "alice/demo" || objectValue(structured)["tool"] != "jj" {
		t.Fatalf("cloneResult structured = %#v", structured)
	}
	text := cloneResult("", "demo", "target", GitProtocolHTTPS, "git", &incur.CommandContext{})
	if stringValue(text) != "Cloned target into target using git" {
		t.Fatalf("cloneResult text = %#v", text)
	}
}
