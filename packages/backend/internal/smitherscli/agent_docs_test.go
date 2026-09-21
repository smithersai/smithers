//go:build linux

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

	incur "github.com/smithersai/incur"
)

func TestAgentDocsSearchFindsRelevantSection(t *testing.T) {
	docs := strings.TrimSpace(`
# Smithers Docs

## Authentication

Use ` + "`smithers auth login`" + ` to start browser login and store credentials securely.

## Agent

The local-first helper prefers Smithers docs search over guessing.
`)
	index := buildAgentDocsIndex(docs)
	results := searchAgentDocsIndex(&index, "browser login", 4)
	if len(results) == 0 {
		t.Fatal("expected docs search results")
	}
	if !strings.Contains(results[0].Title, "Authentication") {
		t.Fatalf("expected Authentication hit first, got %#v", results[0])
	}
	if !strings.Contains(results[0].Snippet, "smithers auth login") {
		t.Fatalf("expected snippet to include auth command, got %q", results[0].Snippet)
	}
}

func TestRefreshAgentDocsCacheUsesConditionalHeaders(t *testing.T) {
	cacheDir := t.TempDir()
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"docs-v1"`)
		w.Header().Set("Last-Modified", "Wed, 11 Mar 2026 12:00:00 GMT")
		fmt.Fprint(w, "# Smithers Docs\n\nLocal-first agent docs.\n")
	}))
	t.Setenv("SMITHERS_AGENT_DOCS_URL", first.URL)
	fresh := refreshAgentDocsCache(cacheDir)
	first.Close()
	if fresh.Status.Status != "fresh" || fresh.Status.Source != "network" {
		t.Fatalf("unexpected fresh status: %#v", fresh.Status)
	}

	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != `"docs-v1"` {
			t.Fatalf("If-None-Match = %q", got)
		}
		if got := r.Header.Get("If-Modified-Since"); got != "Wed, 11 Mar 2026 12:00:00 GMT" {
			t.Fatalf("If-Modified-Since = %q", got)
		}
		w.WriteHeader(http.StatusNotModified)
	}))
	defer second.Close()
	t.Setenv("SMITHERS_AGENT_DOCS_URL", second.URL)
	cached := refreshAgentDocsCache(cacheDir)
	if cached.Status.Status != "fresh" || cached.Status.Source != "cache" {
		t.Fatalf("unexpected cached status: %#v", cached.Status)
	}
	if !strings.Contains(cached.Text, "Local-first agent docs.") {
		t.Fatalf("expected cached body, got %q", cached.Text)
	}
}

func TestAgentAskStructuredLocalDocsResponse(t *testing.T) {
	root := t.TempDir()
	configHome := filepath.Join(root, "cfg")
	cacheHome := filepath.Join(root, "cache")
	repoDir := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeBin := filepath.Join(root, "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeJj := filepath.Join(fakeBin, "jj")
	if err := os.WriteFile(fakeJj, []byte("#!/bin/sh\ncase \"$1 $2 $3\" in\n  '--version  ') echo 'jj 0.33.0' ;;\n  'root  ') pwd ;;\n  'git remote list') echo 'origin git@ssh.smithers.sh:alice/demo.git' ;;\n  'status  ') echo 'The working copy is clean' ;;\n  *) echo \"unexpected jj args: $*\" >&2; exit 1 ;;\nesac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: https://api.smithers.sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	docsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "# Smithers Docs\n\n## Authentication\n\nUse `smithers auth login` for browser login.\n")
	}))
	defer docsServer.Close()

	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_CACHE_HOME", cacheHome)
	t.Setenv("SMITHERS_AGENT_DOCS_URL", docsServer.URL)
	t.Setenv("SMITHERS_TOKEN", "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("PATH", fakeBin)

	oldwd, _ := os.Getwd()
	if err := os.Chdir(repoDir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(oldwd)

	cli := NewCLI()
	var stdout bytes.Buffer
	err := cli.ServeWithOptions([]string{"--json", "agent", "ask", "browser login"}, incur.ServeOptions{Stdout: &stdout})
	if err != nil {
		t.Fatalf("ServeWithOptions returned error: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("invalid JSON output: %v\n%s", err, stdout.String())
	}
	if parsed["backend"] != "local" {
		t.Fatalf("backend = %#v", parsed["backend"])
	}
	if !strings.Contains(stringValue(parsed["response"]), "smithers auth login") {
		t.Fatalf("response did not include docs hit: %#v", parsed["response"])
	}
}
