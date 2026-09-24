package ownership

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// Cases follow GitHub's CODEOWNERS syntax examples, which use gitignore rules.
func TestMatchCodeownersFollowsGitHubSemantics(t *testing.T) {
	cases := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"*", "any/file.txt", true},
		{"*.js", "a/b/c.js", true},
		{"*.js", "a/b/c.ts", false},
		{"*.go", "main.go", true},
		// A leading slash anchors to the root.
		{"/README.md", "README.md", true},
		{"/README.md", "docs/README.md", false},
		{"/docs", "docs/a.md", true},
		{"/docs/", "docs/a/b.md", true},
		// A trailing-slash or bare name matches that directory at any depth.
		{"apps/", "apps/x.go", true},
		{"apps/", "web/apps/x.go", true},
		{"apps/", "apps", false},
		{"src", "src/main.go", true},
		{"src", "lib/src/main.go", true},
		{"src", "srcx/main.go", false},
		// A slash in the middle anchors to the root.
		{"docs/*", "docs/getting-started.md", true},
		{"docs/*", "docs/build-app/troubleshooting.md", false},
		{"apps/github", "apps/github/x.go", true},
		{"apps/github", "web/apps/github/x.go", false},
		{"/build/logs/", "build/logs/a.log", true},
		{"/build/logs/", "x/build/logs/a.log", false},
		{"**/logs", "a/b/logs/x.log", true},
		{"**/logs", "logs/x.log", true},
		{"docs/**", "docs/a/b/c.md", true},
		{"/scripts/*.sh", "scripts/a.sh", true},
		{"/scripts/*.sh", "scripts/sub/a.sh", false},
	}
	for _, tc := range cases {
		require.Equalf(t, tc.want, matchCodeowners(tc.pattern, tc.path), "matchCodeowners(%q, %q)", tc.pattern, tc.path)
	}
}

func TestCODEOWNERSLineWithoutOwnersClearsOwnership(t *testing.T) {
	rules, err := ParseCODEOWNERS("* @org/platform\n/apps/generated/\n")
	require.NoError(t, err)
	tree := Tree{Codeowners: rules}
	require.Empty(t, tree.Resolve("apps/generated/x.go").Owners)
	require.NotNil(t, tree.Resolve("apps/generated/x.go").Owners)
	require.Len(t, tree.Resolve("apps/other/x.go").Owners, 1)
}

type mapLoader map[string]string

func (m mapLoader) LoadFile(_ context.Context, _ string, filePath string) (string, bool, error) {
	content, ok := m[filePath]
	return content, ok, nil
}

func TestLoadTreeFindsCODEOWNERSInGitHubLocationOrder(t *testing.T) {
	for _, loc := range []string{".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"} {
		tree, err := LoadTree(context.Background(), mapLoader{loc: "* @alice\n"}, "rev", []string{"a/b.go"})
		require.NoError(t, err, loc)
		require.Len(t, tree.Codeowners, 1, loc)
	}
	tree, err := LoadTree(context.Background(), mapLoader{
		".github/CODEOWNERS": "* @github\n",
		"CODEOWNERS":         "* @root\n",
	}, "rev", []string{"a/b.go"})
	require.NoError(t, err)
	require.Equal(t, "github", tree.Resolve("a/b.go").Owners[0].Login)
}

func TestLoadTreeReadsAncestorOWNERSFiles(t *testing.T) {
	tree, err := LoadTree(context.Background(), mapLoader{
		"OWNERS":     "root\n",
		"src/OWNERS": "alice\n",
	}, "rev", []string{"src/pkg/x.go"})
	require.NoError(t, err)
	require.Contains(t, tree.Files, "")
	require.Contains(t, tree.Files, "src")
	require.NotContains(t, tree.Files, "src/pkg")
}
