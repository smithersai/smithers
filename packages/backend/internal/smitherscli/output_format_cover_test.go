package smitherscli

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

func outputFormatCovRequireContains(t *testing.T, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Fatalf("output missing %q:\n%s", want, got)
	}
}

func TestOutputFormat_Cov_IssueWikiAndTableFormatting(t *testing.T) {
	if objectValue("not an object") != nil {
		t.Fatal("objectValue accepted a non-map")
	}
	if objectValue(map[string]any{"ok": true})["ok"] != true {
		t.Fatal("objectValue did not return typed map")
	}
	if arrayValue("not an array") != nil {
		t.Fatal("arrayValue accepted a non-array")
	}
	if len(arrayValue([]any{"one"})) != 1 {
		t.Fatal("arrayValue did not return typed slice")
	}
	if got := joinAnyValues([]any{"alpha", "", 3}, "|"); got != "alpha|3" {
		t.Fatalf("joinAnyValues = %q", got)
	}

	table := formatTable([]string{"Name", "State"}, [][]string{{"Longer", "open"}, {"B", "closed", "ignored"}})
	outputFormatCovRequireContains(t, table, "Name    State")
	outputFormatCovRequireContains(t, table, "Longer  open")
	if row := formatTableRow([]string{"x"}, []int{3, 2}); row != "x      " {
		t.Fatalf("formatTableRow = %q", row)
	}

	issue := map[string]any{
		"id":            "iss_1",
		"number":        7,
		"title":         "Crash on launch",
		"body":          "Steps here",
		"state":         "open",
		"milestone_id":  nil,
		"comment_count": 2,
		"created_at":    "2026-01-02T00:00:00Z",
		"author":        map[string]any{"id": "usr_1", "login": "alice"},
		"assignees":     []any{map[string]any{"id": "usr_2", "login": "bob"}, map[string]any{"login": ""}, "bad"},
	}
	if got := issueAuthor(issue); got != "alice" {
		t.Fatalf("issueAuthor = %q", got)
	}
	if got := issueAuthor(map[string]any{}); got != "unknown" {
		t.Fatalf("issueAuthor fallback = %q", got)
	}
	if got := issueAssignees(issue); got != "bob" {
		t.Fatalf("issueAssignees = %q", got)
	}
	if got := formatIssueCreate(issue); got != "Created issue #7: Crash on launch" {
		t.Fatalf("formatIssueCreate = %q", got)
	}
	toon := formatIssueCreateToon(issue)
	outputFormatCovRequireContains(t, toon, "author:")
	outputFormatCovRequireContains(t, toon, "assignees[3]{id,login}:")
	outputFormatCovRequireContains(t, toon, "created_at: \"2026-01-02T00:00:00Z\"")
	if got := formatIssueList(nil); got != "No issues found" {
		t.Fatalf("formatIssueList empty = %q", got)
	}
	outputFormatCovRequireContains(t, formatIssueList([]any{issue}), "#7")
	view := formatIssueView(issue)
	outputFormatCovRequireContains(t, view, "Assignees: bob")
	outputFormatCovRequireContains(t, view, "Steps here")
	if got := formatIssueMutation("Closed", issue); got != "Closed issue #7: Crash on launch" {
		t.Fatalf("formatIssueMutation = %q", got)
	}

	page := map[string]any{
		"title":      "Home",
		"slug":       "home",
		"body":       "Welcome",
		"updated_at": "2026-01-03",
		"author":     map[string]any{"login": "writer"},
	}
	if got := wikiAuthor(page); got != "writer" {
		t.Fatalf("wikiAuthor = %q", got)
	}
	if got := wikiAuthor(map[string]any{}); got != "unknown" {
		t.Fatalf("wikiAuthor fallback = %q", got)
	}
	if got := formatWikiCreate(page); got != "Created wiki page Home (home)" {
		t.Fatalf("formatWikiCreate = %q", got)
	}
	if got := formatWikiList(nil); got != "No wiki pages found" {
		t.Fatalf("formatWikiList empty = %q", got)
	}
	outputFormatCovRequireContains(t, formatWikiList([]any{page}), "writer")
	outputFormatCovRequireContains(t, formatWikiView(page), "Updated: 2026-01-03")
	if got := formatWikiMutation("Deleted", page); got != "Deleted wiki page Home (home)" {
		t.Fatalf("formatWikiMutation = %q", got)
	}
	if got := formatWikiRevisionList(nil); got != "No revisions found" {
		t.Fatalf("formatWikiRevisionList empty = %q", got)
	}
	revisions := formatWikiRevisionList([]any{map[string]any{"id": 12, "title": "Home", "author": map[string]any{}, "updated_at": "today"}})
	outputFormatCovRequireContains(t, revisions, "unknown")

	apiErr := cleanAPIError(&APIError{Method: http.MethodGet, Path: "/x", Status: http.StatusBadRequest, Detail: "bad request"})
	if apiErr == nil || apiErr.Error() != "bad request" {
		t.Fatalf("cleanAPIError APIError = %v", apiErr)
	}
	plain := errors.New("plain")
	if cleanAPIError(plain) != plain {
		t.Fatal("cleanAPIError should return non-API errors unchanged")
	}
}

func TestOutputFormat_Cov_RepoLandingFormatting(t *testing.T) {
	repo := map[string]any{
		"id":               "repo_1",
		"owner":            "alice",
		"name":             "demo",
		"description":      "Example repo",
		"is_public":        true,
		"default_branch":   "main",
		"default_bookmark": "",
		"clone_url":        "https://example.com/alice/demo.git",
		"num_stars":        5,
		"created_at":       "2026-01-02",
		"updated_at":       "2026-01-03",
	}
	if got := repoFullName(map[string]any{"full_name": "alice/demo"}); got != "alice/demo" {
		t.Fatalf("repoFullName full_name = %q", got)
	}
	if got := repoFullName(repo); got != "alice/demo" {
		t.Fatalf("repoFullName owner/name = %q", got)
	}
	if got := repoFullName(map[string]any{"name": "demo"}); got != "demo" {
		t.Fatalf("repoFullName name fallback = %q", got)
	}
	if repoVisibility(repo) != "public" || repoVisibility(map[string]any{"is_public": false}) != "private" || repoVisibility(map[string]any{}) != "" {
		t.Fatal("repoVisibility returned unexpected values")
	}
	outputFormatCovRequireContains(t, formatRepoCreate(repo), "Clone URL: https://example.com/alice/demo.git")
	outputFormatCovRequireContains(t, formatRepoCreateToon(repo), "clone_url: \"https://example.com/alice/demo.git\"")
	if got := formatRepoList(nil); got != "No repositories found" {
		t.Fatalf("formatRepoList empty = %q", got)
	}
	outputFormatCovRequireContains(t, formatRepoList([]any{repo}), "public")
	view := formatRepoView(repo)
	outputFormatCovRequireContains(t, view, "Description: Example repo")
	outputFormatCovRequireContains(t, view, "Stars: 5")
	outputFormatCovRequireContains(t, formatRepoView(map[string]any{"name": "mystery"}), "Visibility: unknown")
	if got := formatRepoMutation("Archived", "alice/demo"); got != "Archived repository alice/demo" {
		t.Fatalf("formatRepoMutation = %q", got)
	}
	if got := firstNonEmptyAny("", nil, "main"); got != "main" {
		t.Fatalf("firstNonEmptyAny = %#v", got)
	}

	landing := map[string]any{
		"number":          4,
		"title":           "Land stack",
		"body":            "Please land",
		"state":           "open",
		"target_bookmark": "main",
		"conflict_status": "clean",
		"stack_size":      2,
		"change_ids":      []any{"abc", "def"},
		"author":          map[string]any{"id": "u1", "login": "alice"},
		"created_at":      "2026-02-01",
		"updated_at":      "2026-02-02",
	}
	if got := landingAuthor(landing); got != "alice" {
		t.Fatalf("landingAuthor = %q", got)
	}
	if got := landingAuthor(map[string]any{}); got != "unknown" {
		t.Fatalf("landingAuthor fallback = %q", got)
	}
	outputFormatCovRequireContains(t, formatLandingCreate("alice/demo", landing), "/alice/demo/landings/4")
	if got := formatLandingList(nil); got != "No landing requests found" {
		t.Fatalf("formatLandingList empty = %q", got)
	}
	outputFormatCovRequireContains(t, formatLandingList([]any{landing}), "abc, def")
	outputFormatCovRequireContains(t, formatLandingListToon([]any{landing}), "change_ids[2]: abc,def")
	details := map[string]any{
		"landing":   landing,
		"changes":   []any{map[string]any{"change_id": "abc"}},
		"reviews":   []any{map[string]any{"type": "approval", "body": ""}},
		"conflicts": map[string]any{"conflict_status": "clean"},
	}
	landingView := formatLandingView(details)
	outputFormatCovRequireContains(t, landingView, "Changes:")
	outputFormatCovRequireContains(t, landingView, "approval: (no body)")
	outputFormatCovRequireContains(t, landingView, "Conflicts: clean")
	if got := formatLandingChecks(nil); got != "No checks found" {
		t.Fatalf("formatLandingChecks empty = %q", got)
	}
	outputFormatCovRequireContains(t, formatLandingChecks([]any{map[string]any{"change_id": "abc", "context": "ci", "status": "passing", "description": "ok"}}), "passing")
	if got := formatLandingMutation("Closed", landing); got != "Closed landing request #4: Land stack" {
		t.Fatalf("formatLandingMutation = %q", got)
	}
}

func TestOutputFormat_Cov_ToonHelpers(t *testing.T) {
	lines := []string{}
	record := map[string]any{"top": "value", "quoted": "needs quote", "nil": nil}
	appendToonField(&lines, record, "top", false)
	appendToonField(&lines, record, "quoted", true)
	appendToonField(&lines, record, "missing", false)
	appendNestedToonField(&lines, record, "top", false)
	appendDoubleNestedToonField(&lines, record, "top", false)
	appendListToonField(&lines, record, "top", false, true)
	appendListToonField(&lines, record, "nil", false, false)
	got := strings.Join(lines, "\n")
	for _, want := range []string{
		"top: value",
		"quoted: \"needs quote\"",
		"  top: value",
		"      top: value",
		"  - top: value",
		"    nil: null",
	} {
		outputFormatCovRequireContains(t, got, want)
	}
	if toonScalar(nil, false) != "null" || toonScalar("x", true) != `"x"` || toonScalar(9, false) != "9" {
		t.Fatal("toonScalar returned unexpected values")
	}
}
