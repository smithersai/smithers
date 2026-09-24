package diffview

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestBuildFileDiff_IgnoreWhitespaceHidesReindentedLinesInARealChange(t *testing.T) {
	t.Parallel()

	client := fakeChangeDiffClient{files: map[string]string{
		"parent:main.go": "func a() {\n    x := 1\n    y := 2\n    z := 3\n}\n",
		"change:main.go": "func a() {\n\tx := 1\n\ty := 20\n\tz := 3\n}\n",
	}}
	got, include, err := buildFileDiff(context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"}, BuildOptions{IgnoreWhitespace: true}, newDiffBudget())
	require.NoError(t, err)
	require.True(t, include)
	assert.Equal(t, 1, got.Additions)
	assert.Equal(t, 1, got.Deletions)
	assert.Contains(t, got.Patch, "--- a/main.go\n+++ b/main.go\n")
	assert.Contains(t, got.Patch, "-    y := 2\n")
	assert.Contains(t, got.Patch, "+\ty := 20\n")
	assert.NotContains(t, got.Patch, "-    x := 1")
	assert.NotContains(t, got.Patch, "-    z := 3")

	// Without the option the reindented lines are real changes.
	got, _, err = buildFileDiff(context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"}, BuildOptions{}, newDiffBudget())
	require.NoError(t, err)
	assert.Equal(t, 3, got.Additions)
	assert.Equal(t, 3, got.Deletions)
}
