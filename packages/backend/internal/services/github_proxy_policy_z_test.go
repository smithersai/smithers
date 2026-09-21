package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGithubProxyPolicy_Z_NormalizeParseAndRequiredFields(t *testing.T) {
	t.Parallel()

	assert.False(t, EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Path: "/repos/o/r"}).Allowed)
	assert.False(t, EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "GET"}).Allowed)
	assert.False(t, EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{Method: "GET", Path: "/user/repos"}).Allowed)

	assert.Equal(t, "", normalizeGitHubProxyPath("   "))
	assert.Equal(t, "", normalizeGitHubProxyPath("repos/o/r"))
	assert.Equal(t, "/", normalizeGitHubProxyPath("/../"))
	assert.Equal(t, "/repos/o/r", normalizeGitHubProxyPath(" /repos/o/r?x=1#frag "))

	_, _, _, ok := parseGitHubRepoPath("/repos//repo")
	assert.False(t, ok)
	_, _, _, ok = parseGitHubRepoPath("/repos/owner/")
	assert.False(t, ok)
}
