package smitherscli

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestJjHook_F_ResolveRepoConfigPathEmpty(t *testing.T) {
	binDir := t.TempDir()
	// fake jj that succeeds but prints nothing
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	if got := resolveRepoConfigPath(t.TempDir()); got != "" {
		t.Fatalf("resolveRepoConfigPath empty stdout = %q", got)
	}
}

func TestJjHook_F_InstallWrapperError(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no jj -> resolveRepoConfigPath returns ""
	cwd := t.TempDir()
	// Make .jj a regular file so writeJJConfig's MkdirAll fails.
	if err := os.WriteFile(filepath.Join(cwd, ".jj"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installPushHook(cwd); err == nil {
		t.Fatal("installPushHook should fail when .jj is a file")
	}
}

func TestJjHook_F_RemoveWrapperError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("cannot exercise write-permission failure as root")
	}
	t.Setenv("PATH", t.TempDir()) // no jj
	cwd := t.TempDir()
	jjDir := filepath.Join(cwd, ".jj")
	if err := os.MkdirAll(jjDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(jjDir, "config.toml")
	if err := os.WriteFile(cfg, []byte("[hooks]\npost-operation = [\""+jjPostOperationHook+"\"]\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := removePushHook(cwd); err == nil {
		t.Fatal("removePushHook should fail when config file is read-only")
	}
}

func TestJjHook_F_RemoveAtPathNoopBranches(t *testing.T) {
	dir := t.TempDir()

	// non-empty config with no [hooks] section -> section == nil, return nil
	noSection := filepath.Join(dir, "no-section.toml")
	if err := os.WriteFile(noSection, []byte("[ui]\ncolor = \"auto\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removePushHookAtPath(noSection); err != nil {
		t.Fatalf("removePushHookAtPath no section = %v", err)
	}

	// [hooks] with post-operation that lacks our hook -> nothing removed, return nil
	noMatch := filepath.Join(dir, "no-match.toml")
	before := "[hooks]\npost-operation = [\"other-hook\"]\n"
	if err := os.WriteFile(noMatch, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removePushHookAtPath(noMatch); err != nil {
		t.Fatalf("removePushHookAtPath no match = %v", err)
	}
	after, _ := os.ReadFile(noMatch)
	if string(after) != before {
		t.Fatalf("removePushHookAtPath no match mutated file: %q", string(after))
	}
}

func TestAgentDocs_F_URLDefault(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "")
	if got := agentDocsURL(); got != agentSummaryDocsURL {
		t.Fatalf("agentDocsURL default = %q", got)
	}
}

func TestAgentDocs_F_RefreshDoError(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "http://127.0.0.1:1/docs")
	entry := refreshAgentDocsCache(filepath.Join(t.TempDir(), "cache"))
	if entry.Status.Status != "unavailable" {
		t.Fatalf("refreshAgentDocsCache Do error status = %#v", entry.Status)
	}
}

func TestAgentDocs_F_RefreshReadError(t *testing.T) {
	// Server hijacks the connection and sends a truncated body so ReadAll fails.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			return
		}
		conn, buf, err := hj.Hijack()
		if err != nil {
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nshort")
		_ = buf.Flush()
		_ = conn.Close()
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	t.Setenv("SMITHERS_AGENT_DOCS_URL", "http://"+ln.Addr().String()+"/docs")
	entry := refreshAgentDocsCache(filepath.Join(t.TempDir(), "cache"))
	if entry.Status.Status != "unavailable" {
		t.Fatalf("refreshAgentDocsCache read error status = %#v", entry.Status)
	}
}

func TestAgentDocs_F_CreateChunksEmpty(t *testing.T) {
	chunks := createAgentDocsChunks("   \n  ")
	if len(chunks) != 1 || chunks[0].Title != "Smithers Docs" {
		t.Fatalf("createAgentDocsChunks empty = %#v", chunks)
	}
}

func TestAgentDocs_F_SearchBranches(t *testing.T) {
	// empty query -> nil
	if got := searchAgentDocsIndex(&agentDocsIndex{}, "   ", 5); got != nil {
		t.Fatalf("empty query results = %#v", got)
	}
	// nil index -> nil
	if got := searchAgentDocsIndex(nil, "x", 5); got != nil {
		t.Fatalf("nil index results = %#v", got)
	}

	index := &agentDocsIndex{Chunks: []agentDocsChunk{
		{ID: "0", Title: "Alpha", Text: "alpha match here"},
		{ID: "1", Title: "Beta", Text: "alpha match here too"},
		{ID: "2", Title: "Gamma", Text: "alpha appears here"},
		{ID: "3", Title: "Unrelated", Text: "nothing to see"},
	}}
	// maxResults <= 0 falls back to the default
	if got := searchAgentDocsIndex(index, "alpha", 0); len(got) == 0 {
		t.Fatal("default maxResults should return matches")
	}
	// maxResults capped, and score==0 chunk (Unrelated) skipped
	results := searchAgentDocsIndex(index, "alpha", 2)
	if len(results) != 2 {
		t.Fatalf("expected 2 capped results, got %d: %#v", len(results), results)
	}
	for _, r := range results {
		if r.Title == "Unrelated" {
			t.Fatal("non-matching chunk should be excluded")
		}
	}
}
