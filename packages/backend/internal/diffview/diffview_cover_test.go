package diffview

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// diffviewCoverClient is a fully programmable ChangeDiffClient so each test can
// inject success/failure for the three underlying repohost calls independently.
type diffviewCoverClient struct {
	getChangeFn     func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	getChangeDiffFn func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error)
	getFileFn       func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

func (c diffviewCoverClient) GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
	return c.getChangeFn(ctx, owner, repo, changeID)
}

func (c diffviewCoverClient) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
	return c.getChangeDiffFn(ctx, owner, repo, changeID)
}

func (c diffviewCoverClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return c.getFileFn(ctx, owner, repo, changeID, path)
}

// diffviewCoverFileMap builds a getFileFn that serves content from a
// changeID+":"+path keyed map, returning empty content for unknown keys.
func diffviewCoverFileMap(files map[string]string) func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
		return repohost.FileContent{Path: path, Content: files[changeID+":"+path]}, nil
	}
}

func TestBuildChangeDiff_Cover_GetChangeDiffError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom-diff")
	client := diffviewCoverClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{}, sentinel
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			t.Fatalf("GetChange should not be called when GetChangeDiff fails")
			return repohost.Change{}, nil
		},
		getFileFn: diffviewCoverFileMap(nil),
	}

	got, err := BuildChangeDiff(context.Background(), client, "alice", "demo", "change", BuildOptions{})
	require.ErrorIs(t, err, sentinel)
	assert.Equal(t, repohost.ChangeDiff{}, got)
}

func TestBuildChangeDiff_Cover_GetChangeError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom-change")
	client := diffviewCoverClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{ChangeID: changeID}, nil
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			return repohost.Change{}, sentinel
		},
		getFileFn: diffviewCoverFileMap(nil),
	}

	got, err := BuildChangeDiff(context.Background(), client, "alice", "demo", "change", BuildOptions{})
	require.ErrorIs(t, err, sentinel)
	assert.Equal(t, repohost.ChangeDiff{}, got)
}

func TestBuildChangeDiff_Cover_BuildFileDiffError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom-file")
	client := diffviewCoverClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{
				ChangeID: changeID,
				FileDiffs: []repohost.FileDiff{
					{Path: "main.go", ChangeType: "modified"},
				},
			}, nil
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			return repohost.Change{ParentChangeIDs: []string{"parent"}}, nil
		},
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			return repohost.FileContent{}, sentinel
		},
	}

	got, err := BuildChangeDiff(context.Background(), client, "alice", "demo", "change", BuildOptions{})
	require.ErrorIs(t, err, sentinel)
	assert.Equal(t, repohost.ChangeDiff{}, got)
}

func TestBuildChangeDiff_Cover_Success(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		// Parent (trimmed) contents.
		"parent:main.go":   "package main\n\nfunc main() {}\n",
		"parent:README.md": "hello world\n",
		// Change contents.
		"change:main.go":   "package main\n\nfunc main() { println(\"hi\") }\n",
		"change:README.md": "hello   world\n", // whitespace-only change
	}

	client := diffviewCoverClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{
				ChangeID: changeID,
				FileDiffs: []repohost.FileDiff{
					{Path: "main.go", ChangeType: "modified"},
					{Path: "README.md", ChangeType: "modified"},
				},
			}, nil
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			// Leading/trailing whitespace exercises the TrimSpace of the parent ID.
			return repohost.Change{ParentChangeIDs: []string{"  parent  "}}, nil
		},
		getFileFn: diffviewCoverFileMap(files),
	}

	got, err := BuildChangeDiff(context.Background(), client, "alice", "demo", "change", BuildOptions{IgnoreWhitespace: true})
	require.NoError(t, err)

	// README.md is whitespace-only under IgnoreWhitespace and is dropped, so only
	// main.go survives.
	require.Len(t, got.FileDiffs, 1)
	assert.Equal(t, "main.go", got.FileDiffs[0].Path)
	assert.Equal(t, "go", got.FileDiffs[0].Language)
	assert.NotEmpty(t, got.FileDiffs[0].Patch)
	assert.Positive(t, got.FileDiffs[0].Additions)
}

func TestBuildChangeDiff_Cover_NoParent(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"change:new.go": "package main\n",
	}
	client := diffviewCoverClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{
				ChangeID: changeID,
				FileDiffs: []repohost.FileDiff{
					{Path: "new.go", ChangeType: "added"},
				},
			}, nil
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			// No parents: parentID stays "".
			return repohost.Change{}, nil
		},
		getFileFn: diffviewCoverFileMap(files),
	}

	got, err := BuildChangeDiff(context.Background(), client, "alice", "demo", "change", BuildOptions{})
	require.NoError(t, err)
	require.Len(t, got.FileDiffs, 1)
	assert.Equal(t, "new.go", got.FileDiffs[0].Path)
	assert.Contains(t, got.FileDiffs[0].Patch, "--- /dev/null")
}

func TestBuildFileDiff_Cover_OldFileError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("old-file-boom")
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			return repohost.FileContent{}, sentinel
		},
	}

	_, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.ErrorIs(t, err, sentinel)
	assert.False(t, include)
}

func TestBuildFileDiff_Cover_NewFileError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("new-file-boom")
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			if changeID == "parent" {
				return repohost.FileContent{Content: "old\n"}, nil
			}
			return repohost.FileContent{}, sentinel
		},
	}

	_, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.ErrorIs(t, err, sentinel)
	assert.False(t, include)
}

func TestBuildFileDiff_Cover_UsesOldPathForRename(t *testing.T) {
	t.Parallel()

	var oldFetchedPath string
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			if changeID == "parent" {
				oldFetchedPath = path
				return repohost.FileContent{Content: "line1\nline2\n"}, nil
			}
			return repohost.FileContent{Content: "line1\nline2\nline3\n"}, nil
		},
	}

	got, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "renamed.go", OldPath: "original.go", ChangeType: "renamed"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	// The old content must be fetched from OldPath, not the new Path.
	assert.Equal(t, "original.go", oldFetchedPath)
	assert.Contains(t, got.Patch, "--- a/original.go")
	assert.Contains(t, got.Patch, "+++ b/renamed.go")
}

func TestBuildFileDiff_Cover_BinaryClearsPatch(t *testing.T) {
	t.Parallel()

	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			// Content with a NUL byte marks the file binary.
			return repohost.FileContent{Content: "bin\x00data"}, nil
		},
	}

	got, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "blob.dat", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.IsBinary)
	assert.Empty(t, got.Patch)
	assert.Zero(t, got.Additions)
	assert.Zero(t, got.Deletions)
	assert.Empty(t, got.OldContent)
	assert.Empty(t, got.NewContent)
}

func TestBuildFileDiff_Cover_BinaryByExtension(t *testing.T) {
	t.Parallel()

	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			return repohost.FileContent{Content: "plain but png ext\n"}, nil
		},
	}

	got, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "logo.png", ChangeType: "added"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.IsBinary)
	assert.Empty(t, got.Patch)
}

func TestBuildFileDiff_Cover_DeletedOnlyFetchesOld(t *testing.T) {
	t.Parallel()

	var changesTouched []string
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			changesTouched = append(changesTouched, changeID)
			return repohost.FileContent{Content: "gone\n"}, nil
		},
	}

	got, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "old.go", ChangeType: "deleted"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	// Only the parent (old) content is fetched for a deletion.
	assert.Equal(t, []string{"parent"}, changesTouched)
	assert.Contains(t, got.Patch, "+++ /dev/null")
	assert.Empty(t, got.NewContent)
}

func TestBuildFileDiff_Cover_AddedOnlyFetchesNew(t *testing.T) {
	t.Parallel()

	var changesTouched []string
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			changesTouched = append(changesTouched, changeID)
			return repohost.FileContent{Content: "fresh\n"}, nil
		},
	}

	got, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "parent", "change",
		repohost.FileDiff{Path: "new.go", ChangeType: "added"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	// Added files never fetch the parent content.
	assert.Equal(t, []string{"change"}, changesTouched)
	assert.Contains(t, got.Patch, "--- /dev/null")
	assert.Equal(t, "fresh\n", got.NewContent)
}

func TestBuildFileDiff_Cover_NoParentSkipsOldFetch(t *testing.T) {
	t.Parallel()

	var changesTouched []string
	client := diffviewCoverClient{
		getFileFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			changesTouched = append(changesTouched, changeID)
			return repohost.FileContent{Content: "content\n"}, nil
		},
	}

	// Modified but parentID == "" means the old fetch is skipped.
	_, include, err := buildFileDiff(
		context.Background(), client, "alice", "demo", "", "change",
		repohost.FileDiff{Path: "main.go", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.Equal(t, []string{"change"}, changesTouched)
}

func TestBuildUnifiedPatch_Cover_AddedLabel(t *testing.T) {
	t.Parallel()

	patch, add, del, err := buildUnifiedPatch(
		repohost.FileDiff{Path: "new.go", ChangeType: "added"},
		"",
		"line\n",
	)
	require.NoError(t, err)
	assert.Contains(t, patch, "--- /dev/null")
	assert.Contains(t, patch, "+++ b/new.go")
	assert.Equal(t, 1, add)
	assert.Equal(t, 0, del)
}

func TestBuildUnifiedPatch_Cover_DeletedLabel(t *testing.T) {
	t.Parallel()

	patch, add, del, err := buildUnifiedPatch(
		repohost.FileDiff{Path: "old.go", ChangeType: "deleted"},
		"line\n",
		"",
	)
	require.NoError(t, err)
	assert.Contains(t, patch, "--- a/old.go")
	assert.Contains(t, patch, "+++ /dev/null")
	assert.Equal(t, 0, add)
	assert.Equal(t, 1, del)
}

func TestBuildUnifiedPatch_Cover_RenameLabel(t *testing.T) {
	t.Parallel()

	patch, _, _, err := buildUnifiedPatch(
		repohost.FileDiff{Path: "renamed.go", OldPath: "original.go", ChangeType: "renamed"},
		"a\n",
		"b\n",
	)
	require.NoError(t, err)
	assert.Contains(t, patch, "--- a/original.go")
	assert.Contains(t, patch, "+++ b/renamed.go")
}

func TestDetectLanguage_Cover_AllCases(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		// Base-name special cases.
		"Dockerfile":        "dockerfile",
		"path/Makefile":     "makefile",
		"MAKEFILE":          "makefile",
		"docker/Dockerfile": "dockerfile",
		// Extension cases.
		"a.c":     "c",
		"a.cc":    "cpp",
		"a.cpp":   "cpp",
		"a.cxx":   "cpp",
		"a.css":   "css",
		"a.go":    "go",
		"a.html":  "html",
		"a.htm":   "html",
		"a.java":  "java",
		"a.js":    "javascript",
		"a.mjs":   "javascript",
		"a.cjs":   "javascript",
		"a.json":  "json",
		"a.jsx":   "jsx",
		"a.kt":    "kotlin",
		"a.md":    "markdown",
		"a.py":    "python",
		"a.rb":    "ruby",
		"a.rs":    "rust",
		"a.scss":  "scss",
		"a.sh":    "bash",
		"a.bash":  "bash",
		"a.zsh":   "bash",
		"a.sql":   "sql",
		"a.svg":   "xml",
		"a.swift": "swift",
		"a.toml":  "toml",
		"a.ts":    "typescript",
		"a.tsx":   "tsx",
		"a.txt":   "plaintext",
		"a.xml":   "xml",
		"a.yaml":  "yaml",
		"a.yml":   "yaml",
		// Unknown extension falls through to "".
		"a.unknownext": "",
		"noext":        "",
	}

	for path, want := range cases {
		path, want := path, want
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, want, detectLanguage(path, ""))
		})
	}
}

func TestDetectLanguage_Cover_PrefersCurrent(t *testing.T) {
	t.Parallel()

	// A non-empty (trimmed) current language wins over extension detection.
	assert.Equal(t, "custom", detectLanguage("a.go", "  custom  "))
	// A whitespace-only current falls through to extension detection.
	assert.Equal(t, "go", detectLanguage("a.go", "   "))
}
