package ownership

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseAndResolveOWNERS(t *testing.T) {
	root, err := ParseOWNERS(`
alice
team:web
agents: human-approve
agents: auto-land **/*.md
reviewers: carol # upstream-of //src
`)
	require.NoError(t, err)
	data, err := ParseOWNERS(`
set noparent
team:data
per-file *.graphql = dave
agents: deny
`)
	require.NoError(t, err)

	tree := Tree{Files: map[string]File{"": root, "data": data}}
	md := tree.Resolve("docs/guide.md")
	assert.Equal(t, PolicyAutoLand, md.AgentPolicy)
	assert.Equal(t, []string{"//", "//src"}, md.Packages)
	assert.Equal(t, []string{"alice", "team:web"}, approveIDs(md.Owners))
	assert.Contains(t, md.Owners, Principal{Login: "carol", Role: RoleReview, Reasons: []string{"upstream-of //src"}})

	graphql := tree.Resolve("data/nested/schema.graphql")
	assert.Equal(t, "//data", graphql.Package)
	assert.Equal(t, PolicyDeny, graphql.AgentPolicy)
	assert.Equal(t, []string{"team:data", "dave"}, approveIDs(graphql.Owners))
	assert.NotContains(t, approveIDs(graphql.Owners), "alice")
}

func TestInheritanceAndNearestAgentDeclaration(t *testing.T) {
	root, _ := ParseOWNERS("alice\nagents: deny\n")
	src, _ := ParseOWNERS("bob\nagents: auto-land **/*.md\n")
	tree := Tree{Files: map[string]File{"": root, "src": src}}

	goFile := tree.Resolve("src/pkg/main.go")
	assert.Equal(t, PolicyDeny, goFile.AgentPolicy, "override-only file falls through when no override matches")
	assert.Equal(t, []string{"bob", "alice"}, approveIDs(goFile.Owners))
	assert.Contains(t, goFile.Owners[1].Reasons, "inherited from //")
	assert.Equal(t, PolicyAutoLand, tree.Resolve("src/docs/readme.md").AgentPolicy)
}

func TestAgentPolicyResolutionTable(t *testing.T) {
	file, err := ParseOWNERS("agents: human-approve\nagents: auto-land **/*.md\nagents: deny Server/**\n")
	require.NoError(t, err)
	tree := Tree{Files: map[string]File{"src": file}}
	for _, tc := range []struct{ path, want string }{
		{"src/readme.md", PolicyAutoLand},
		{"src/docs/deep/guide.md", PolicyAutoLand},
		{"src/Server/main.go", PolicyDeny},
		{"src/client/main.go", PolicyHumanApprove},
	} {
		t.Run(tc.path, func(t *testing.T) { assert.Equal(t, tc.want, tree.Resolve(tc.path).AgentPolicy) })
	}
}

func TestCODEOWNERSFallbackAndOWNERSPrecedence(t *testing.T) {
	rules, err := ParseCODEOWNERS("*.go @org/platform\n/docs/ @writer\n")
	require.NoError(t, err)
	root, _ := ParseOWNERS("alice\n")
	tree := Tree{Files: map[string]File{"src": root}, Codeowners: rules}

	assert.Equal(t, []string{"team:platform"}, approveIDs(tree.Resolve("cmd/tool/main.go").Owners))
	assert.Equal(t, []string{"alice"}, approveIDs(tree.Resolve("src/main.go").Owners))
	assert.Equal(t, []string{"writer"}, approveIDs(tree.Resolve("docs/deep/page.md").Owners))
}

func TestParseOWNERSRejectsMalformedGeneratedInput(t *testing.T) {
	tests := []string{
		"alice\nset noparent\n",
		"agents: maybe\n",
		"per-file *.go team:web\n",
		"reviewers:\n",
		"unknown: thing\n",
	}
	for _, input := range tests {
		_, err := ParseOWNERS(input)
		assert.Error(t, err, input)
	}
}

func approveIDs(items []Principal) []string {
	var out []string
	for _, item := range items {
		if item.Role == RoleApprove {
			out = append(out, item.ID())
		}
	}
	return out
}
