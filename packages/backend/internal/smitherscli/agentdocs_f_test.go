package smitherscli

import (
	"net"
	"net/http"
	"path/filepath"
	"testing"
)

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
