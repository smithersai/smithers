package services

import (
	"encoding/json"
	"testing"
)

func TestGithubProxyPolicy_Cov_NormalizesAndParsesRepoPaths(t *testing.T) {
	normalized := normalizeGitHubProxyPath(" /repos/Alice/Demo/contents/../issues?state=open#frag ")
	if normalized != "/repos/Alice/Demo/issues" {
		t.Fatalf("normalized path = %q", normalized)
	}

	owner, repo, subpath, ok := parseGitHubRepoPath(normalized)
	if !ok || owner != "Alice" || repo != "Demo" || subpath != "/issues" {
		t.Fatalf("parse = (%q,%q,%q,%v)", owner, repo, subpath, ok)
	}

	if got := normalizeGitHubProxyPath("repos/alice/demo"); got != "" {
		t.Fatalf("relative path normalized to %q, want empty", got)
	}
	if _, _, _, ok := parseGitHubRepoPath("/users/alice/repos"); ok {
		t.Fatal("non-/repos path parsed successfully")
	}
}

func TestGithubProxyPolicy_Cov_CoversWriteAndDenyBranches(t *testing.T) {
	base := GitHubProxyPolicyInput{RepoOwner: "alice", RepoName: "demo"}

	tests := []struct {
		name    string
		input   GitHubProxyPolicyInput
		allowed bool
		reason  string
	}{
		{
			name:    "missing method",
			input:   GitHubProxyPolicyInput{Path: "/repos/alice/demo"},
			allowed: false,
			reason:  "method is required",
		},
		{
			name: "repository mismatch",
			input: GitHubProxyPolicyInput{
				Method: "GET", Path: "/repos/bob/demo", RepoOwner: "alice", RepoName: "demo",
			},
			allowed: false,
			reason:  gitHubProxyReasonRepositoryMismatch,
		},
		{
			name: "merge denied",
			input: GitHubProxyPolicyInput{
				Method: "PUT", Path: "/repos/alice/demo/pulls/1/merge", RepoOwner: "alice", RepoName: "demo",
			},
			allowed: false,
			reason:  gitHubProxyReasonMergeDenied,
		},
		{
			name: "merge allowed",
			input: GitHubProxyPolicyInput{
				Method: "PUT", Path: "/repos/alice/demo/pulls/1/merge", RepoOwner: "alice", RepoName: "demo", AllowMerges: true,
			},
			allowed: true,
			reason:  "pull request merge allowed",
		},
		{
			name: "pull update allowed",
			input: GitHubProxyPolicyInput{
				Method: "PATCH", Path: "/repos/alice/demo/pulls/9", RepoOwner: "alice", RepoName: "demo", AllowPullWrites: true,
			},
			allowed: true,
			reason:  "pull request update allowed",
		},
		{
			name: "delete non smithers branch denied",
			input: GitHubProxyPolicyInput{
				Method: "DELETE", Path: "/repos/alice/demo/git/refs/heads/main", RepoOwner: "alice", RepoName: "demo", AllowBranchDeletes: true,
			},
			allowed: false,
			reason:  gitHubProxyReasonPushBranchDenied,
		},
		{
			name: "create smithers ref allowed",
			input: GitHubProxyPolicyInput{
				Method: "POST", Path: "/repos/alice/demo/git/refs", RepoOwner: "alice", RepoName: "demo",
				Body: json.RawMessage(`{"ref":"refs/heads/smithers/test"}`),
			},
			allowed: true,
			reason:  "git ref write allowed",
		},
		{
			name: "metadata read",
			input: GitHubProxyPolicyInput{
				Method: "GET", Path: "/repos/alice/demo/issues/1", RepoOwner: "alice", RepoName: "demo",
			},
			allowed: true,
			reason:  "metadata read allowed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := EvaluateGitHubProxyPolicy(tt.input)
			if decision.Allowed != tt.allowed || decision.Reason != tt.reason {
				t.Fatalf("decision = %+v, want allowed=%v reason=%q", decision, tt.allowed, tt.reason)
			}
		})
	}

	decision := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{
		Method: "GET", Path: "/repos/alice/demo/contents/src/main.go", RepoOwner: base.RepoOwner, RepoName: base.RepoName,
	})
	if !decision.Allowed {
		t.Fatalf("contents read denied: %+v", decision)
	}
}

func TestGithubProxyPolicy_Cov_ExtractRefAndSmithersBranches(t *testing.T) {
	for _, body := range []json.RawMessage{
		nil,
		json.RawMessage(``),
		json.RawMessage(`null`),
		json.RawMessage(`{"ref":"   "}`),
		json.RawMessage(`not-json`),
	} {
		if ref, ok := extractRefFromRequestBody(body); ok || ref != "" {
			t.Fatalf("extractRefFromRequestBody(%q) = %q, %v", string(body), ref, ok)
		}
	}

	ref, ok := extractRefFromRequestBody(json.RawMessage(`{"ref":" heads/smithers/abc "}`))
	if !ok || ref != "heads/smithers/abc" {
		t.Fatalf("ref = %q, ok=%v", ref, ok)
	}

	cases := map[string]bool{
		"refs/heads/smithers/abc": true,
		"heads/smithers/abc":      true,
		"refs/heads/smithers/":    false,
		"smithers/abc":            false,
	}
	for ref, want := range cases {
		if got := isSmithersBranchRef(ref); got != want {
			t.Fatalf("isSmithersBranchRef(%q) = %v, want %v", ref, got, want)
		}
	}
}
