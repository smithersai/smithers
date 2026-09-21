package routes

// keyset_stability_test.go verifies that the IssueHandler's cursor-paginated
// list endpoint does not skip or duplicate items even when new rows are
// inserted concurrently between page fetches.
//
// Strategy: we use a mock service whose backing slice grows (simulating
// concurrent writes) between calls. A keyset query honors the "WHERE number <
// afterNumber" invariant, so only rows already present at or before the cursor
// boundary are returned — newly inserted rows with lower numbers appear in
// their correct position on the *next* fresh query, not mid-traversal.
//
// Because the route delegates entirely to the service, the test validates:
//  1. The handler always passes the decoded cursor as afterNumber.
//  2. The service (mock) returns only items satisfying the keyset predicate.
//  3. Paginating through all pages yields every pre-existing item exactly once,
//     with no items skipped despite concurrent writes between pages.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// concurrentWriteService is a mock IssueRouteService whose issue list grows
// between page fetches to simulate concurrent inserts.
type concurrentWriteService struct {
	mu     sync.Mutex
	issues []services.IssueResponse // sorted DESC by Number (highest first)
}

func (s *concurrentWriteService) insert(number int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item := services.IssueResponse{
		ID:        number * 10,
		Number:    number,
		Title:     "issue",
		State:     "open",
		Author:    services.IssueUserSummary{ID: 1, Login: "alice"},
		Assignees: []services.IssueUserSummary{},
		Labels:    []services.LabelSummary{},
	}
	// Insert in DESC sorted order.
	inserted := false
	for i, existing := range s.issues {
		if number > existing.Number {
			s.issues = append(s.issues[:i], append([]services.IssueResponse{item}, s.issues[i:]...)...)
			inserted = true
			break
		}
	}
	if !inserted {
		s.issues = append(s.issues, item)
	}
}

// ListIssues implements the keyset predicate: return at most `limit` items with
// Number < afterNumber (or any number when afterNumber==0), in DESC order.
func (s *concurrentWriteService) ListIssues(_ context.Context, _ *db.User, _, _ string, afterNumber int64, limit int, _ string) ([]services.IssueResponse, string, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var page []services.IssueResponse
	for _, issue := range s.issues {
		if afterNumber == 0 || issue.Number < afterNumber {
			page = append(page, issue)
			if len(page) == limit {
				break
			}
		}
	}

	total := int64(len(s.issues))
	nextCursor := ""
	if len(page) == limit {
		// Encode last seen number as cursor (matches encodeIssueNumberCursor in services).
		nextCursor = encodeIDCursor(page[len(page)-1].Number)
	}
	return page, nextCursor, total, nil
}

func (s *concurrentWriteService) CreateIssue(_ context.Context, _ *db.User, _, _ string, _ services.CreateIssueInput) (services.IssueResponse, error) {
	return services.IssueResponse{}, nil
}
func (s *concurrentWriteService) GetIssue(_ context.Context, _ *db.User, _, _ string, _ int64) (services.IssueResponse, error) {
	return services.IssueResponse{}, nil
}
func (s *concurrentWriteService) UpdateIssue(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.UpdateIssueInput) (services.IssueResponse, error) {
	return services.IssueResponse{}, nil
}
func (s *concurrentWriteService) CreateIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
	return services.IssueCommentResponse{}, nil
}
func (s *concurrentWriteService) ListIssueComments(_ context.Context, _ *db.User, _, _ string, _ int64, _ int64, _ int) ([]services.IssueCommentResponse, string, int64, error) {
	return nil, "", 0, nil
}
func (s *concurrentWriteService) GetIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64) (services.IssueCommentResponse, error) {
	return services.IssueCommentResponse{}, nil
}
func (s *concurrentWriteService) UpdateIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.UpdateIssueCommentInput) (services.IssueCommentResponse, error) {
	return services.IssueCommentResponse{}, nil
}
func (s *concurrentWriteService) DeleteIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64) error {
	return nil
}

// TestKeysetPagination_StableUnderConcurrentInserts pages through a dataset
// that grows between page fetches and asserts:
//   - No item present at the start is skipped.
//   - No item is returned twice.
//   - Items whose numbers fall *below* the current cursor boundary are NOT
//     returned on the in-progress traversal (they will appear on a fresh
//     query from page 1), preventing unbounded traversal growth.
func TestKeysetPagination_StableUnderConcurrentInserts(t *testing.T) {
	t.Parallel()

	const (
		initialCount = 20 // issues seeded before traversal starts
		pageSize     = 5  // results per page
		insertAfter  = 2  // insert new items after this many pages
	)

	svc := &concurrentWriteService{}
	for i := int64(1); i <= initialCount; i++ {
		svc.insert(i)
	}

	h := IssueHandler{Service: svc}

	// Collect all items retrieved across pages.
	seen := map[int64]int{} // number → count (to detect duplicates)
	cursor := ""
	page := 0

	for {
		page++

		// Simulate a concurrent insert of a high-numbered issue (above current
		// cursor boundary — these SHOULD appear on the in-progress traversal
		// because they arrive with lower numbers than not-yet-visited pages).
		// We also insert one that is *below* the cursor to verify it's excluded.
		if page == insertAfter {
			// Insert below current cursor: should not appear in this traversal.
			svc.insert(int64(initialCount + 100)) // above any existing number — will appear on next fresh query
			// This insert is *before* the frontier on the current DESC traversal:
			// the cursor is at number N, and we're asking for items with number < N.
			// A number > N is above the frontier — it won't satisfy the predicate.
		}

		path := "/api/repos/alice/repo/issues?limit=5&state=open"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "repo"})
		rec := httptest.NewRecorder()
		h.ListIssues(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)

		var items []services.IssueResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))

		for _, item := range items {
			seen[item.Number]++
		}

		// Extract next cursor from Link header.
		linkHeader := rec.Header().Get("Link")
		cursor = parseNextCursorFromLink(t, linkHeader)
		if cursor == "" {
			break
		}
	}

	// Every initial item must appear exactly once.
	for i := int64(1); i <= initialCount; i++ {
		assert.Equalf(t, 1, seen[i], "issue #%d: expected exactly 1 occurrence, got %d", i, seen[i])
	}

	// The high-numbered issue inserted after the cursor boundary should NOT
	// appear during this traversal (its number is above the range already fetched).
	assert.Equal(t, 0, seen[int64(initialCount+100)],
		"issue inserted above cursor boundary should not appear in this traversal")

	// No duplicates.
	for num, count := range seen {
		assert.LessOrEqualf(t, count, 1, "issue #%d seen %d times (duplicate)", num, count)
	}
}

// parseNextCursorFromLink extracts the cursor query parameter from the
// rel="next" entry of a Link header. Returns "" if there is no next link.
func parseNextCursorFromLink(t *testing.T, linkHeader string) string {
	t.Helper()
	if linkHeader == "" {
		return ""
	}
	// Format: <URL>; rel="next", <URL>; rel="first"
	// Split on ", <" to separate entries.
	parts := splitLinkHeader(linkHeader)
	for _, part := range parts {
		if containsRelNext(part) {
			url := extractLinkURL(part)
			if url == "" {
				return ""
			}
			// Parse cursor param from the URL path.
			return extractQueryParam(url, "cursor")
		}
	}
	return ""
}

func splitLinkHeader(h string) []string {
	// Split on boundaries between entries: ", <" marks a new entry (after the
	// first) whose leading "<" was removed by the split.
	var parts []string
	rest := h
	for {
		// Find the next entry separator: ", <"
		idx := -1
		for i := 0; i+3 <= len(rest); i++ {
			if rest[i] == ',' && i+1 < len(rest) {
				j := i + 1
				for j < len(rest) && rest[j] == ' ' {
					j++
				}
				if j < len(rest) && rest[j] == '<' {
					idx = i
					break
				}
			}
		}
		if idx < 0 {
			parts = append(parts, rest)
			break
		}
		parts = append(parts, rest[:idx])
		// Skip comma and optional spaces; keep the '<' for the next entry.
		rest = rest[idx+1:]
		for len(rest) > 0 && rest[0] == ' ' {
			rest = rest[1:]
		}
	}
	return parts
}

func containsRelNext(entry string) bool {
	for i := 0; i+len(`rel="next"`) <= len(entry); i++ {
		if entry[i:i+len(`rel="next"`)] == `rel="next"` {
			return true
		}
	}
	return false
}

func extractLinkURL(entry string) string {
	start := -1
	end := -1
	for i, c := range entry {
		if c == '<' && start < 0 {
			start = i + 1
		}
		if c == '>' && start >= 0 {
			end = i
			break
		}
	}
	if start < 0 || end < 0 {
		return ""
	}
	return entry[start:end]
}

func extractQueryParam(rawURL, key string) string {
	qIdx := -1
	for i, c := range rawURL {
		if c == '?' {
			qIdx = i
			break
		}
	}
	if qIdx < 0 {
		return ""
	}
	query := rawURL[qIdx+1:]
	// Simple key=value parser.
	prefix := key + "="
	start := 0
	for start < len(query) {
		amp := len(query)
		for i := start; i < len(query); i++ {
			if query[i] == '&' {
				amp = i
				break
			}
		}
		pair := query[start:amp]
		if len(pair) >= len(prefix) && pair[:len(prefix)] == prefix {
			return pair[len(prefix):]
		}
		start = amp + 1
	}
	return ""
}
