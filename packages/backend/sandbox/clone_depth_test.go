package sandbox

import "testing"

// A zero depth is the common case — no caller opts in — so it must resolve to
// the bounded default rather than to full history.
func TestResolveCloneDepth(t *testing.T) {
	for _, tc := range []struct {
		name  string
		given int
		want  int
	}{
		{name: "unset takes the platform default", given: 0, want: DefaultCloneDepth},
		{name: "explicit depth is used as-is", given: 1, want: 1},
		{name: "deep window is used as-is", given: 5000, want: 5000},
		{name: "full history drops the depth argument", given: FullCloneDepth, want: 0},
		{name: "any negative depth means full history", given: -42, want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveCloneDepth(tc.given); got != tc.want {
				t.Fatalf("ResolveCloneDepth(%d) = %d, want %d", tc.given, got, tc.want)
			}
		})
	}
}

// The default has to cover the coding flows' history window (100 native
// commits) with room for the working-copy commit and a merge or two.
func TestDefaultCloneDepthCoversTheCodingHistoryWindow(t *testing.T) {
	const codingHistoryLimit = 100
	if DefaultCloneDepth < 2*codingHistoryLimit {
		t.Fatalf("DefaultCloneDepth = %d, want at least %d", DefaultCloneDepth, 2*codingHistoryLimit)
	}
}
