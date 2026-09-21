package smitherscli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	agentDocsIndexMaxChunkChars = 1500
	agentDocsDefaultResults     = 4
)

type agentDocsStatus struct {
	URL          string `json:"url"`
	Status       string `json:"status"`
	Source       string `json:"source"`
	FetchedAt    string `json:"fetchedAt,omitempty"`
	Warning      string `json:"warning,omitempty"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
}

type agentDocsCacheEntry struct {
	Text   string          `json:"-"`
	Status agentDocsStatus `json:"status"`
	Paths  agentDocsPaths  `json:"paths"`
}

type agentDocsPaths struct {
	Dir      string `json:"dir"`
	Body     string `json:"body"`
	Metadata string `json:"metadata"`
}

type agentDocsMetadata struct {
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	FetchedAt    string `json:"fetchedAt"`
	URL          string `json:"url"`
}

type agentDocsChunk struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	Text      string `json:"text"`
}

type agentDocsIndex struct {
	SourceHash string           `json:"sourceHash"`
	BuiltAt    string           `json:"builtAt"`
	Chunks     []agentDocsChunk `json:"chunks"`
}

type agentDocsSearchResult struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	Score     int    `json:"score"`
	Snippet   string `json:"snippet"`
}

func agentDocsURL() string {
	if value := strings.TrimSpace(os.Getenv("SMITHERS_AGENT_DOCS_URL")); value != "" {
		return value
	}
	return agentSummaryDocsURL
}

func agentDocsCachePaths(cacheDirectory string) agentDocsPaths {
	dir := cacheDirectory
	if strings.TrimSpace(dir) == "" {
		dir = filepath.Join(CacheDir(), "agent", "docs")
	}
	return agentDocsPaths{
		Dir:      dir,
		Body:     filepath.Join(dir, "llms-full.txt"),
		Metadata: filepath.Join(dir, "llms-full.json"),
	}
}

func readAgentDocsMetadata(paths agentDocsPaths) *agentDocsMetadata {
	raw, err := os.ReadFile(paths.Metadata)
	if err != nil {
		return nil
	}
	var metadata agentDocsMetadata
	if err := json.Unmarshal(raw, &metadata); err != nil || metadata.URL == "" || metadata.FetchedAt == "" {
		return nil
	}
	return &metadata
}

func loadCachedAgentDocs(cacheDirectory string) agentDocsCacheEntry {
	paths := agentDocsCachePaths(cacheDirectory)
	raw, bodyErr := os.ReadFile(paths.Body)
	metadata := readAgentDocsMetadata(paths)
	if bodyErr != nil || metadata == nil || strings.TrimSpace(string(raw)) == "" {
		return agentDocsCacheEntry{
			Paths: paths,
			Status: agentDocsStatus{
				URL:     agentDocsURL(),
				Status:  "unavailable",
				Source:  "none",
				Warning: "No Smithers docs cache is available yet.",
			},
		}
	}
	return agentDocsCacheEntry{
		Text:  string(raw),
		Paths: paths,
		Status: agentDocsStatus{
			URL:          metadata.URL,
			Status:       "stale",
			Source:       "cache",
			FetchedAt:    metadata.FetchedAt,
			ETag:         metadata.ETag,
			LastModified: metadata.LastModified,
			Warning:      "Using cached Smithers docs.",
		},
	}
}

func refreshAgentDocsCache(cacheDirectory string) agentDocsCacheEntry {
	paths := agentDocsCachePaths(cacheDirectory)
	url := agentDocsURL()
	cached := loadCachedAgentDocs(cacheDirectory)
	metadata := readAgentDocsMetadata(paths)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return agentDocsUnavailableOrStale(cached, url, err)
	}
	if metadata != nil {
		if metadata.ETag != "" {
			req.Header.Set("If-None-Match", metadata.ETag)
		}
		if metadata.LastModified != "" {
			req.Header.Set("If-Modified-Since", metadata.LastModified)
		}
	}
	client := &http.Client{Timeout: agentDocsRefreshTimeout()}
	resp, err := client.Do(req)
	if err != nil {
		return agentDocsUnavailableOrStale(cached, url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotModified && cached.Text != "" {
		cached.Status.URL = url
		cached.Status.Status = "fresh"
		cached.Status.Source = "cache"
		cached.Status.Warning = ""
		return cached
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return agentDocsUnavailableOrStale(cached, url, fmt.Errorf("Docs download failed with status %d", resp.StatusCode))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return agentDocsUnavailableOrStale(cached, url, err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	nextMetadata := agentDocsMetadata{
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
		FetchedAt:    now,
		URL:          url,
	}
	_ = os.MkdirAll(paths.Dir, 0o755)
	_ = os.WriteFile(paths.Body, raw, 0o644)
	if metadataBytes, err := json.MarshalIndent(nextMetadata, "", "  "); err == nil {
		_ = os.WriteFile(paths.Metadata, append(metadataBytes, '\n'), 0o644)
	}
	return agentDocsCacheEntry{
		Text:  string(raw),
		Paths: paths,
		Status: agentDocsStatus{
			URL:          url,
			Status:       "fresh",
			Source:       "network",
			FetchedAt:    now,
			ETag:         nextMetadata.ETag,
			LastModified: nextMetadata.LastModified,
		},
	}
}

func agentDocsRefreshTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_AGENT_DOCS_TIMEOUT_MS"))
	if raw == "" {
		return 3 * time.Second
	}
	ms, err := time.ParseDuration(raw + "ms")
	if err == nil && ms > 0 {
		return ms
	}
	return 3 * time.Second
}

func agentDocsUnavailableOrStale(cached agentDocsCacheEntry, url string, err error) agentDocsCacheEntry {
	if cached.Text != "" {
		cached.Status.URL = url
		cached.Status.Status = "stale"
		cached.Status.Source = "cache"
		cached.Status.Warning = "Using cached Smithers docs because refresh failed: " + err.Error()
		return cached
	}
	cached.Status = agentDocsStatus{
		URL:     url,
		Status:  "unavailable",
		Source:  "none",
		Warning: "Smithers docs are unavailable: " + err.Error(),
	}
	return cached
}

func buildAgentDocsIndex(text string) agentDocsIndex {
	return agentDocsIndex{
		SourceHash: sha256Hex(text),
		BuiltAt:    time.Now().UTC().Format(time.RFC3339Nano),
		Chunks:     createAgentDocsChunks(text),
	}
}

func prepareAgentDocsIndex(entry agentDocsCacheEntry) *agentDocsIndex {
	if strings.TrimSpace(entry.Text) == "" {
		return nil
	}
	sourceHash := sha256Hex(entry.Text)
	indexPath := filepath.Join(entry.Paths.Dir, "llms-full.index.json")
	if raw, err := os.ReadFile(indexPath); err == nil {
		var cached agentDocsIndex
		if json.Unmarshal(raw, &cached) == nil && cached.SourceHash == sourceHash && len(cached.Chunks) > 0 {
			return &cached
		}
	}
	index := buildAgentDocsIndex(entry.Text)
	if raw, err := json.MarshalIndent(index, "", "  "); err == nil {
		_ = os.WriteFile(indexPath, append(raw, '\n'), 0o644)
	}
	return &index
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func createAgentDocsChunks(text string) []agentDocsChunk {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	chunks := []agentDocsChunk{}
	headingStack := []string{}
	sectionTitle := "Smithers Docs"
	buffer := []string{}
	chunkStart := 1
	chunkIndex := 0

	flush := func(lineEnd int) {
		joined := strings.TrimSpace(strings.Join(buffer, "\n"))
		if joined == "" {
			buffer = nil
			chunkStart = lineEnd + 1
			return
		}
		push := func(start, end int, body string) {
			chunks = append(chunks, agentDocsChunk{
				ID:        fmt.Sprint(chunkIndex),
				Title:     sectionTitle,
				LineStart: start,
				LineEnd:   end,
				Text:      body,
			})
			chunkIndex++
		}
		if len(joined) <= agentDocsIndexMaxChunkChars {
			push(chunkStart, lineEnd, joined)
			buffer = nil
			chunkStart = lineEnd + 1
			return
		}
		sectionLines := strings.Split(joined, "\n")
		part := []string{}
		partStart := chunkStart
		currentLine := chunkStart
		for _, line := range sectionLines {
			projected := strings.Join(append(append([]string{}, part...), line), "\n")
			if len(part) > 0 && len(projected) > agentDocsIndexMaxChunkChars {
				push(partStart, currentLine-1, strings.Join(part, "\n"))
				part = []string{line}
				partStart = currentLine
			} else {
				part = append(part, line)
			}
			currentLine++
		}
		if len(part) > 0 {
			push(partStart, lineEnd, strings.Join(part, "\n"))
		}
		buffer = nil
		chunkStart = lineEnd + 1
	}

	for i, line := range lines {
		if level, title, ok := parseAgentDocsHeading(line); ok {
			flush(i)
			for len(headingStack) < level {
				headingStack = append(headingStack, "")
			}
			headingStack = headingStack[:level]
			headingStack[level-1] = title
			filtered := []string{}
			for _, item := range headingStack {
				if item != "" {
					filtered = append(filtered, item)
				}
			}
			// parseAgentDocsHeading always returns a non-empty title, so the
			// current heading guarantees filtered has at least one entry.
			sectionTitle = strings.Join(filtered, " > ")
			chunkStart = i + 1
			continue
		}
		buffer = append(buffer, line)
	}
	flush(len(lines))
	if len(chunks) == 0 {
		chunks = append(chunks, agentDocsChunk{ID: "0", Title: "Smithers Docs", LineStart: 1, LineEnd: len(lines), Text: strings.TrimSpace(text)})
	}
	return chunks
}

func parseAgentDocsHeading(line string) (int, string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "#") {
		return 0, "", false
	}
	level := 0
	for level < len(trimmed) && trimmed[level] == '#' {
		level++
	}
	if level == 0 || level > 6 || level >= len(trimmed) || trimmed[level] != ' ' {
		return 0, "", false
	}
	return level, strings.TrimSpace(trimmed[level+1:]), true
}

func searchAgentDocsIndex(index *agentDocsIndex, query string, maxResults int) []agentDocsSearchResult {
	if index == nil {
		return nil
	}
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" {
		return nil
	}
	if maxResults <= 0 {
		maxResults = agentDocsDefaultResults
	}
	if maxResults > 8 {
		maxResults = 8
	}
	tokens := uniqueAgentSearchTokens(normalized)
	results := []agentDocsSearchResult{}
	for _, chunk := range index.Chunks {
		haystack := strings.ToLower(chunk.Text)
		title := strings.ToLower(chunk.Title)
		score := 0
		if strings.Contains(title, normalized) {
			score += 12
		}
		if strings.Contains(haystack, normalized) {
			score += 8
		}
		for _, token := range tokens {
			score += strings.Count(title, token) * 5
			score += strings.Count(haystack, token)
		}
		if score == 0 {
			continue
		}
		results = append(results, agentDocsSearchResult{
			ID:        chunk.ID,
			Title:     chunk.Title,
			LineStart: chunk.LineStart,
			LineEnd:   chunk.LineEnd,
			Score:     score,
			Snippet:   buildAgentDocsSnippet(chunk.Text, tokens),
		})
	}
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})
	if len(results) > maxResults {
		results = results[:maxResults]
	}
	return results
}

func uniqueAgentSearchTokens(query string) []string {
	fields := strings.FieldsFunc(query, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '/' || r == ':' || r == '-')
	})
	seen := map[string]struct{}{}
	tokens := []string{}
	for _, field := range fields {
		token := strings.TrimSpace(field)
		if len(token) < 2 {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		tokens = append(tokens, token)
	}
	return tokens
}

func buildAgentDocsSnippet(text string, tokens []string) string {
	lines := strings.Split(text, "\n")
	lowerText := strings.ToLower(text)
	firstMatch := 0
	for _, token := range tokens {
		if idx := strings.Index(lowerText, token); idx >= 0 {
			firstMatch = idx
			break
		}
	}
	if firstMatch == 0 {
		return strings.Join(lines[:minInt(len(lines), 12)], "\n")
	}
	startLine := strings.Count(text[:firstMatch], "\n")
	start := maxInt(0, startLine-2)
	end := minInt(len(lines), startLine+10)
	return strings.Join(lines[start:end], "\n")
}

func formatAgentDocsResults(results []agentDocsSearchResult, status agentDocsStatus) string {
	if len(results) == 0 {
		if status.Warning != "" {
			return status.Warning
		}
		return "No Smithers docs sections matched the prompt."
	}
	parts := make([]string, 0, len(results))
	for i, result := range results {
		parts = append(parts, fmt.Sprintf("[%d] %s (lines %d-%d)\n%s", i+1, result.Title, result.LineStart, result.LineEnd, result.Snippet))
	}
	text := strings.Join(parts, "\n\n")
	if status.Status == "stale" && status.Warning != "" {
		text += "\n\n[Using cached Smithers docs: " + status.Warning + "]"
	}
	return text
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
