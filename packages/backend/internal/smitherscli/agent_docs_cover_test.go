package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAgentDocs_Cov_CacheRefreshAndIndexPersistence(t *testing.T) {
	cacheDir := t.TempDir()
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "https://docs.example.test/llms.txt")
	if got := agentDocsURL(); got != "https://docs.example.test/llms.txt" {
		t.Fatalf("agentDocsURL override = %q", got)
	}
	paths := agentDocsCachePaths(cacheDir)
	if paths.Dir != cacheDir || paths.Body != filepath.Join(cacheDir, "llms-full.txt") || paths.Metadata != filepath.Join(cacheDir, "llms-full.json") {
		t.Fatalf("agentDocsCachePaths custom = %#v", paths)
	}
	t.Setenv("XDG_CACHE_HOME", filepath.Join(t.TempDir(), "cache"))
	defaultPaths := agentDocsCachePaths("")
	if !strings.HasSuffix(defaultPaths.Dir, filepath.Join("smithers", "agent", "docs")) {
		t.Fatalf("agentDocsCachePaths default = %#v", defaultPaths)
	}

	if metadata := readAgentDocsMetadata(paths); metadata != nil {
		t.Fatalf("readAgentDocsMetadata missing = %#v", metadata)
	}
	if entry := loadCachedAgentDocs(cacheDir); entry.Text != "" || entry.Status.Status != "unavailable" || entry.Status.Source != "none" {
		t.Fatalf("loadCachedAgentDocs empty = %#v", entry)
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Metadata, []byte(`{"url":"","fetchedAt":"now"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if metadata := readAgentDocsMetadata(paths); metadata != nil {
		t.Fatalf("readAgentDocsMetadata invalid = %#v", metadata)
	}

	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path+" "+r.Header.Get("If-None-Match"))
		switch r.URL.Path {
		case "/fresh":
			w.Header().Set("ETag", `"agent-docs-v1"`)
			w.Header().Set("Last-Modified", "Wed, 11 Mar 2026 12:00:00 GMT")
			fmt.Fprint(w, "# Smithers Docs\n\n## Agent\n\nUse agents for local workflows.\n")
		case "/not-modified":
			if got := r.Header.Get("If-None-Match"); got != `"agent-docs-v1"` {
				t.Fatalf("If-None-Match = %q", got)
			}
			if got := r.Header.Get("If-Modified-Since"); got != "Wed, 11 Mar 2026 12:00:00 GMT" {
				t.Fatalf("If-Modified-Since = %q", got)
			}
			w.WriteHeader(http.StatusNotModified)
		case "/error":
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, "bad gateway")
		default:
			t.Fatalf("unexpected docs path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/error")
	unavailable := refreshAgentDocsCache(filepath.Join(t.TempDir(), "empty-cache"))
	if unavailable.Status.Status != "unavailable" || !strings.Contains(unavailable.Status.Warning, "502") {
		t.Fatalf("refreshAgentDocsCache no cache error = %#v", unavailable.Status)
	}

	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/fresh")
	fresh := refreshAgentDocsCache(cacheDir)
	if fresh.Status.Status != "fresh" || fresh.Status.Source != "network" || !strings.Contains(fresh.Text, "Use agents") {
		t.Fatalf("refreshAgentDocsCache fresh = %#v", fresh)
	}
	metadata := readAgentDocsMetadata(paths)
	if metadata == nil || metadata.ETag != `"agent-docs-v1"` || metadata.URL != server.URL+"/fresh" {
		t.Fatalf("written metadata = %#v", metadata)
	}
	cached := loadCachedAgentDocs(cacheDir)
	if cached.Status.Status != "stale" || cached.Status.Source != "cache" || cached.Status.ETag != `"agent-docs-v1"` {
		t.Fatalf("loadCachedAgentDocs populated = %#v", cached.Status)
	}
	if index := prepareAgentDocsIndex(agentDocsCacheEntry{Paths: paths}); index != nil {
		t.Fatalf("prepareAgentDocsIndex empty text = %#v", index)
	}
	index := prepareAgentDocsIndex(fresh)
	if index == nil || len(index.Chunks) == 0 || index.SourceHash != sha256Hex(fresh.Text) {
		t.Fatalf("prepareAgentDocsIndex fresh = %#v", index)
	}
	indexAgain := prepareAgentDocsIndex(fresh)
	if indexAgain == nil || indexAgain.SourceHash != index.SourceHash || len(indexAgain.Chunks) != len(index.Chunks) {
		t.Fatalf("prepareAgentDocsIndex cached = %#v", indexAgain)
	}

	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/not-modified")
	notModified := refreshAgentDocsCache(cacheDir)
	if notModified.Status.Status != "fresh" || notModified.Status.Source != "cache" || notModified.Status.Warning != "" {
		t.Fatalf("refreshAgentDocsCache 304 = %#v", notModified.Status)
	}
	t.Setenv("SMITHERS_AGENT_DOCS_URL", server.URL+"/error")
	stale := refreshAgentDocsCache(cacheDir)
	if stale.Status.Status != "stale" || stale.Status.Source != "cache" || !strings.Contains(stale.Status.Warning, "refresh failed") {
		t.Fatalf("refreshAgentDocsCache stale = %#v", stale.Status)
	}
	if len(requests) < 4 {
		t.Fatalf("expected refresh requests, saw %v", requests)
	}

	directStale := agentDocsUnavailableOrStale(fresh, "https://next.example/docs", fmt.Errorf("boom"))
	if directStale.Status.URL != "https://next.example/docs" || directStale.Status.Status != "stale" {
		t.Fatalf("agentDocsUnavailableOrStale cached = %#v", directStale.Status)
	}
	directUnavailable := agentDocsUnavailableOrStale(agentDocsCacheEntry{}, "https://next.example/docs", fmt.Errorf("boom"))
	if directUnavailable.Status.Status != "unavailable" || !strings.Contains(directUnavailable.Status.Warning, "boom") {
		t.Fatalf("agentDocsUnavailableOrStale empty = %#v", directUnavailable.Status)
	}

	t.Setenv("SMITHERS_AGENT_DOCS_TIMEOUT_MS", "25")
	if got := agentDocsRefreshTimeout(); got != 25*time.Millisecond {
		t.Fatalf("agentDocsRefreshTimeout valid = %s", got)
	}
	t.Setenv("SMITHERS_AGENT_DOCS_TIMEOUT_MS", "0")
	if got := agentDocsRefreshTimeout(); got != 3*time.Second {
		t.Fatalf("agentDocsRefreshTimeout zero = %s", got)
	}
	t.Setenv("SMITHERS_AGENT_DOCS_URL", "://bad-url")
	if badURL := refreshAgentDocsCache(filepath.Join(t.TempDir(), "bad-url")); badURL.Status.Status != "unavailable" || !strings.Contains(badURL.Status.Warning, "missing protocol") {
		t.Fatalf("refreshAgentDocsCache bad URL = %#v", badURL.Status)
	}

	rawIndex, err := os.ReadFile(filepath.Join(paths.Dir, "llms-full.index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded agentDocsIndex
	if err := json.Unmarshal(rawIndex, &decoded); err != nil || decoded.SourceHash != index.SourceHash {
		t.Fatalf("persisted index invalid: %#v err=%v", decoded, err)
	}
}

func TestAgentDocs_Cov_IndexSearchSnippetsAndFormatting(t *testing.T) {
	longLines := make([]string, 0, 90)
	for i := 0; i < 90; i++ {
		longLines = append(longLines, fmt.Sprintf("line %02d has repeated workspace provisioning details", i))
	}
	docs := strings.Join([]string{
		"# Smithers Docs",
		"",
		"Intro line before headings.",
		"## Agent",
		"Agent session setup and browser login.",
		"### Workspace",
		strings.Join(longLines, "\n"),
		"## API",
		"Token auth and repo paths.",
	}, "\n")
	index := buildAgentDocsIndex(docs)
	if index.SourceHash != sha256Hex(docs) || index.BuiltAt == "" || len(index.Chunks) < 3 {
		t.Fatalf("buildAgentDocsIndex = %#v", index)
	}
	foundWorkspaceTitle := false
	for _, chunk := range index.Chunks {
		if strings.Contains(chunk.Title, "Agent > Workspace") {
			foundWorkspaceTitle = true
		}
		if len(chunk.Text) > agentDocsIndexMaxChunkChars+80 {
			t.Fatalf("chunk too large: %d chars in %#v", len(chunk.Text), chunk)
		}
	}
	if !foundWorkspaceTitle {
		t.Fatalf("workspace title not found in chunks: %#v", index.Chunks)
	}
	noHeadingChunks := createAgentDocsChunks("plain text only")
	if len(noHeadingChunks) != 1 || noHeadingChunks[0].Title != "Smithers Docs" || noHeadingChunks[0].Text != "plain text only" {
		t.Fatalf("createAgentDocsChunks no headings = %#v", noHeadingChunks)
	}
	for _, tc := range []struct {
		line      string
		wantLevel int
		wantTitle string
		wantOK    bool
	}{
		{"### Title", 3, "Title", true},
		{"####### too deep", 0, "", false},
		{"#NoSpace", 0, "", false},
		{"plain", 0, "", false},
	} {
		level, title, ok := parseAgentDocsHeading(tc.line)
		if level != tc.wantLevel || title != tc.wantTitle || ok != tc.wantOK {
			t.Fatalf("parseAgentDocsHeading(%q) = (%d,%q,%t)", tc.line, level, title, ok)
		}
	}

	if got := uniqueAgentSearchTokens("agent agent a /repo/path auth:v1 smithers.sh"); !reflect.DeepEqual(got, []string{"agent", "/repo/path", "auth:v1", "smithers.sh"}) {
		t.Fatalf("uniqueAgentSearchTokens = %#v", got)
	}
	if results := searchAgentDocsIndex(nil, "agent", 3); results != nil {
		t.Fatalf("searchAgentDocsIndex nil = %#v", results)
	}
	if results := searchAgentDocsIndex(&index, "   ", 3); results != nil {
		t.Fatalf("searchAgentDocsIndex blank = %#v", results)
	}
	results := searchAgentDocsIndex(&index, "workspace provisioning", 99)
	if len(results) == 0 || len(results) > 8 || !strings.Contains(results[0].Title, "Workspace") || results[0].Score == 0 {
		t.Fatalf("searchAgentDocsIndex workspace = %#v", results)
	}
	if !strings.Contains(results[0].Snippet, "workspace provisioning") {
		t.Fatalf("search snippet missing query text: %q", results[0].Snippet)
	}
	if noHits := searchAgentDocsIndex(&index, "notpresent", 4); len(noHits) != 0 {
		t.Fatalf("searchAgentDocsIndex no hits = %#v", noHits)
	}

	firstSnippet := buildAgentDocsSnippet("agent first\nsecond\nthird", []string{"agent"})
	if firstSnippet != "agent first\nsecond\nthird" {
		t.Fatalf("buildAgentDocsSnippet first = %q", firstSnippet)
	}
	laterText := strings.Join([]string{"zero", "one", "two", "three token", "four", "five"}, "\n")
	laterSnippet := buildAgentDocsSnippet(laterText, []string{"token"})
	if !strings.Contains(laterSnippet, "one") || !strings.Contains(laterSnippet, "three token") {
		t.Fatalf("buildAgentDocsSnippet later = %q", laterSnippet)
	}
	if minInt(2, 5) != 2 || minInt(8, 3) != 3 || maxInt(2, 5) != 5 || maxInt(8, 3) != 8 {
		t.Fatal("minInt/maxInt returned unexpected values")
	}

	formatted := formatAgentDocsResults(results[:1], agentDocsStatus{Status: "stale", Warning: "cache is old"})
	if !strings.Contains(formatted, "[1]") || !strings.Contains(formatted, "Using cached Smithers docs") {
		t.Fatalf("formatAgentDocsResults stale = %q", formatted)
	}
	if got := formatAgentDocsResults(nil, agentDocsStatus{Warning: "offline"}); got != "offline" {
		t.Fatalf("formatAgentDocsResults warning = %q", got)
	}
	if got := formatAgentDocsResults(nil, agentDocsStatus{}); got != "No Smithers docs sections matched the prompt." {
		t.Fatalf("formatAgentDocsResults empty = %q", got)
	}
}
