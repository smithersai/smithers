package smitherscli

import "testing"

func argsCovRequireSlice(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len(%v) = %d, want %d (%v)", got, len(got), len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("arg[%d] = %q, want %q; got %v want %v", i, got[i], want[i], got, want)
		}
	}
}

func argsCovRequireCommandIndex(t *testing.T, argv []string, want *int) {
	t.Helper()
	got := findFirstCommandIndex(argv)
	if want == nil {
		if got != nil {
			t.Fatalf("findFirstCommandIndex(%v) = %d, want nil", argv, *got)
		}
		return
	}
	if got == nil || *got != *want {
		if got == nil {
			t.Fatalf("findFirstCommandIndex(%v) = nil, want %d", argv, *want)
		}
		t.Fatalf("findFirstCommandIndex(%v) = %d, want %d", argv, *got, *want)
	}
}

func TestArgs_Cov_CommandDetectionAndAgentDefaults(t *testing.T) {
	idx := 2
	argsCovRequireCommandIndex(t, []string{"--format", "json", "repo", "list"}, &idx)
	idx = 1
	argsCovRequireCommandIndex(t, []string{"--format=json", "issue"}, &idx)
	argsCovRequireCommandIndex(t, []string{"--", "repo"}, nil)
	argsCovRequireCommandIndex(t, []string{"--help"}, nil)

	for _, tc := range []struct {
		argv []string
		want bool
	}{
		{argv: nil, want: true},
		{argv: []string{"--schema"}, want: false},
		{argv: []string{"--format", "json"}, want: true},
		{argv: []string{"repo", "list"}, want: false},
	} {
		if got := shouldDefaultToAgent(tc.argv); got != tc.want {
			t.Fatalf("shouldDefaultToAgent(%v) = %t, want %t", tc.argv, got, tc.want)
		}
	}

	argsCovRequireSlice(t, rewriteAgentArgv([]string{"repo", "list"}), []string{"repo", "list"})
	argsCovRequireSlice(t, rewriteAgentArgv([]string{"agent", "hello"}), []string{"agent", "ask", "hello"})
	argsCovRequireSlice(t, rewriteAgentArgv([]string{"agent", "run", "hello"}), []string{"agent", "run", "hello"})
	argsCovRequireSlice(t, rewriteAgentArgv([]string{"agent", "--repo", "alice/demo", "--sandbox", "hello"}), []string{"agent", "ask", "--repo", "alice/demo", "--sandbox", "hello"})
	argsCovRequireSlice(t, rewriteAgentArgv([]string{"agent", "--", "literal"}), []string{"agent", "ask", "--", "literal"})
}

func TestArgs_Cov_AliasesToonAndJSONFieldSelection(t *testing.T) {
	argsCovRequireSlice(t,
		rewriteKnownAliases([]string{"-R", "alice/demo", "--change-id", "abc", "--change-id=def", "--other"}),
		[]string{"--repo", "alice/demo", "--change", "abc", "--change=def", "--other"},
	)
	argsCovRequireSlice(t, rewriteExplicitToonFlag([]string{"repo", "list", "--toon"}), []string{"repo", "list", "--format", "toon"})

	for _, token := range []string{"owner.login", "items[0]", "name,state"} {
		if !isJSONFieldSelectionToken(token) {
			t.Fatalf("%q should be a JSON field selection token", token)
		}
	}
	if isJSONFieldSelectionToken("name") {
		t.Fatal("plain name should not be a complex JSON field selection token")
	}
	for _, token := range []string{"name", "_private", "field1"} {
		if !isTerminalJSONFieldSelectionToken(token) {
			t.Fatalf("%q should be terminal JSON field selection", token)
		}
	}
	for _, token := range []string{"", "1bad", "bad-name"} {
		if isTerminalJSONFieldSelectionToken(token) {
			t.Fatalf("%q should not be terminal JSON field selection", token)
		}
	}
	for _, token := range []string{"42", "alice/demo", "host:path"} {
		if !isLikelyPositionalArgumentToken(token) {
			t.Fatalf("%q should be positional-like", token)
		}
	}
	if isLikelyPositionalArgumentToken("title") {
		t.Fatal("plain title should not be positional-like")
	}

	argsCovRequireSlice(t,
		rewriteJSONFieldSelection([]string{"repo", "list", "--json", "name,owner"}),
		[]string{"repo", "list", "--json", "--filter-output", "name,owner"},
	)
	argsCovRequireSlice(t,
		rewriteJSONFieldSelection([]string{"issue", "view", "--json", "number", "12"}),
		[]string{"issue", "view", "--json", "--filter-output", "number", "12"},
	)
	argsCovRequireSlice(t,
		rewriteJSONFieldSelection([]string{"issue", "view", "--json", "number", "title"}),
		[]string{"issue", "view", "--json", "number", "title"},
	)
	argsCovRequireSlice(t, rewriteJSONFieldSelection([]string{"--json", "--help"}), []string{"--json", "--help"})
}

func TestArgs_Cov_RepoCloneAndFullRewritePipeline(t *testing.T) {
	argsCovRequireSlice(t,
		rewriteRepoCloneArgv([]string{"repo", "clone", "alice/demo", "checkout", "--", "--depth", "1"}),
		[]string{"repo", "clone", "alice/demo", "--directory", "checkout", "--clone-arg", "--depth", "--clone-arg", "1"},
	)
	argsCovRequireSlice(t,
		rewriteRepoCloneArgv([]string{"--format", "json", "repo", "clone", "--protocol", "https", "alice/demo", "checkout"}),
		[]string{"--format", "json", "repo", "clone", "--protocol", "https", "alice/demo", "--directory", "checkout"},
	)
	argsCovRequireSlice(t, rewriteRepoCloneArgv([]string{"repo", "list", "alice/demo"}), []string{"repo", "list", "alice/demo"})

	argsCovRequireSlice(t, rewriteCLIArgv(nil), []string{"agent", "ask"})
	argsCovRequireSlice(t,
		rewriteCLIArgv([]string{"--toon", "repo", "list", "--json", "name"}),
		[]string{"--format", "toon", "repo", "list", "--json", "--filter-output", "name"},
	)
	argsCovRequireSlice(t,
		rewriteCLIArgv([]string{"-R", "alice/demo", "agent", "hello"}),
		[]string{"--repo", "alice/demo", "agent", "ask", "hello"},
	)
	argsCovRequireSlice(t,
		rewriteCLIArgv([]string{"repo", "clone", "alice/demo", "checkout", "--", "--depth"}),
		[]string{"repo", "clone", "alice/demo", "--directory", "checkout", "--clone-arg", "--depth"},
	)
}
