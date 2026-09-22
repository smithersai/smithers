package db

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestQueryContract_ListQueriesUsePagination(t *testing.T) {
	t.Parallel()

	expectations := []struct {
		file      string
		queryName string
	}{
		{file: "agent.sql", queryName: "ListAgentMessages"},
		{file: "issues.sql", queryName: "ListIssueEventsByIssue"},
		{file: "issues.sql", queryName: "ListIssuesByRepoFiltered"},
		{file: "issues.sql", queryName: "ListIssueComments"},
		{file: "landings.sql", queryName: "ListLandingRequestsWithChangeIDsByRepoFiltered"},
		{file: "landings.sql", queryName: "ListLandingRequestChanges"},
		{file: "notifications.sql", queryName: "ListNotificationsByUser"},
		{file: "workflows.sql", queryName: "ListWorkflowDefinitionsByRepo"},
		{file: "workflows.sql", queryName: "ListWorkflowRunsByRepo"},
	}

	for _, tc := range expectations {
		tc := tc
		t.Run(tc.file+"_"+tc.queryName, func(t *testing.T) {
			sql := readQueryFile(t, tc.file)
			section := querySection(t, sql, tc.queryName)
			assert.Regexp(t, regexp.MustCompile(`(?is)\blimit\b`), section)
			assert.Regexp(t, regexp.MustCompile(`(?is)\boffset\b`), section)
		})
	}
}

func TestQueryContract_UsersIncludesCreateUser(t *testing.T) {
	t.Parallel()

	sql := readQueryFile(t, "users.sql")
	assert.Regexp(t, regexp.MustCompile(`(?m)^--\s*name:\s*CreateUser\s*:one\s*$`), sql)
}

func TestQueryContract_SearchQueriesUsePagination(t *testing.T) {
	t.Parallel()

	sql := readQueryFile(t, "search.sql")
	queries := []string{
		"SearchRepositoriesFTS",
		"SearchIssuesFTS",
		"SearchUsersFTS",
	}

	for _, queryName := range queries {
		queryName := queryName
		t.Run(queryName, func(t *testing.T) {
			section := querySection(t, sql, queryName)
			assert.Regexp(t, regexp.MustCompile(`(?is)\blimit\b`), section)
			assert.Regexp(t, regexp.MustCompile(`(?is)\boffset\b`), section)
		})
	}
}

func TestQueryContract_SearchQueriesUseSetBasedVisibilityFiltering(t *testing.T) {
	t.Parallel()

	sql := readQueryFile(t, "search.sql")
	queries := []string{
		"SearchRepositoriesFTS",
		"CountSearchRepositoriesFTS",
		"SearchIssuesFTS",
		"CountSearchIssuesFTS",
		"SearchCodeFTS",
		"CountSearchCodeFTS",
	}

	for _, queryName := range queries {
		queryName := queryName
		t.Run(queryName, func(t *testing.T) {
			section := querySection(t, sql, queryName)
			assert.NotContains(t, strings.ToLower(section), "can_view_repository")
			assert.Contains(t, strings.ToLower(section), "visible_repositories")
		})
	}
}

func TestQueryContract_JJVcsFilesExist(t *testing.T) {
	t.Parallel()

	requiredFiles := []string{
		"bookmarks.sql",
		"changes.sql",
		"conflicts.sql",
		"protected_bookmarks.sql",
		"jj_operations.sql",
	}

	for _, file := range requiredFiles {
		file := file
		t.Run(file, func(t *testing.T) {
			content := readQueryFile(t, file)
			assert.NotEmpty(t, strings.TrimSpace(content))
		})
	}
}

func TestQueryContract_NoPullRequestOrDefaultBranchTerms(t *testing.T) {
	t.Parallel()

	queryFiles, err := filepath.Glob(filepath.Join("..", "..", "db", "product", "queries", "*.sql"))
	require.NoError(t, err)
	if len(queryFiles) == 0 {
		queryFiles, err = filepath.Glob(filepath.Join("db", "product", "queries", "*.sql"))
		require.NoError(t, err)
	}
	require.NotEmpty(t, queryFiles, "expected at least one product query SQL file")

	prohibitedTerms := []string{
		"pull_request",
		"default_branch",
		"protected_branches",
	}

	for _, file := range queryFiles {
		file := file
		t.Run(filepath.Base(file), func(t *testing.T) {
			contentBytes, readErr := os.ReadFile(file)
			require.NoError(t, readErr)
			content := strings.ToLower(string(contentBytes))
			for _, term := range prohibitedTerms {
				assert.NotContainsf(t, content, term, "query file %s contains prohibited term %q", file, term)
			}
		})
	}
}

func TestQueryContract_CreateAgentMessageWithNextSequence_DependsOnLockedSession(t *testing.T) {
	t.Parallel()

	sql := readQueryFile(t, "agent.sql")
	section := querySection(t, sql, "CreateAgentMessageWithNextSequence")

	assert.NotRegexp(t, regexp.MustCompile(`(?is)\bnext_seq\s+as\b`), section)
	assert.Regexp(t, regexp.MustCompile(`(?is)\binsert\s+into\s+agent_messages\b.*\bfrom\s+locked_session\b`), section)
	assert.Regexp(t, regexp.MustCompile(`(?is)\bwhere\s+session_id\s*=\s*ls\.id\b`), section)
}

func readQueryFile(t *testing.T, file string) string {
	t.Helper()

	candidates := []string{
		filepath.Join("..", "..", "db", "product", "queries", file),
		filepath.Join("db", "product", "queries", file),
	}

	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err == nil {
			return string(data)
		}
	}

	require.FailNowf(t, "query file missing", "failed to locate %s", file)
	return ""
}

func querySection(t *testing.T, sql, queryName string) string {
	t.Helper()

	re := regexp.MustCompile(`(?s)--\s*name:\s*` + regexp.QuoteMeta(queryName) + `\s*:[^\n]*\n(.*?)(?:\n--\s*name:|\z)`)
	matches := re.FindStringSubmatch(sql)
	require.Lenf(t, matches, 2, "query %s not found", queryName)
	return matches[1]
}
