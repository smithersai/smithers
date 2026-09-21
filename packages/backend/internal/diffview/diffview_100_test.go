package diffview

import (
	"context"
	"errors"
	"testing"

	"github.com/pmezard/go-difflib/difflib"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func diffviewHWithUnifiedDiffStringError(t *testing.T, err error) {
	t.Helper()

	orig := diffviewGetUnifiedDiffString
	diffviewGetUnifiedDiffString = func(diff difflib.UnifiedDiff) (string, error) {
		return "", err
	}
	t.Cleanup(func() {
		diffviewGetUnifiedDiffString = orig
	})
}

func TestDiffview_H_BuildUnifiedPatchPropagatesDiffError(t *testing.T) {
	sentinel := errors.New("diff writer failed")
	diffviewHWithUnifiedDiffStringError(t, sentinel)

	patch, additions, deletions, err := buildUnifiedPatch(
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"},
		"old\n",
		"new\n",
	)

	require.ErrorIs(t, err, sentinel)
	assert.Empty(t, patch)
	assert.Zero(t, additions)
	assert.Zero(t, deletions)
}

func TestDiffview_H_BuildFileDiffPropagatesPatchError(t *testing.T) {
	sentinel := errors.New("diff writer failed")
	diffviewHWithUnifiedDiffStringError(t, sentinel)
	client := diffviewCoverClient{
		getFileFn: diffviewCoverFileMap(map[string]string{
			"parent:main.go": "old\n",
			"change:main.go": "new\n",
		}),
	}

	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)

	require.ErrorIs(t, err, sentinel)
	assert.False(t, include)
	assert.Equal(t, repohost.FileDiff{}, got)
}
