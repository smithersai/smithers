package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizeBookmarkRef_WithRefsHeadsPrefix(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("refs/heads/main")
	assert.Equal(t, "main", result)
}

func TestNormalizeBookmarkRef_WithoutPrefix(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("main")
	assert.Equal(t, "main", result)
}

func TestNormalizeBookmarkRef_WithWhitespace(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("  main  ")
	assert.Equal(t, "main", result)
}

func TestNormalizeBookmarkRef_NestedBranch(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("refs/heads/feature/new")
	assert.Equal(t, "feature/new", result)
}

func TestNormalizeBookmarkRef_EmptyString(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("")
	assert.Equal(t, "", result)
}

func TestNormalizeBookmarkRef_OnlyWhitespace(t *testing.T) {
	t.Parallel()

	result := normalizeBookmarkRef("   ")
	assert.Equal(t, "", result)
}

func TestNormalizeBookmarkRef_TagRef(t *testing.T) {
	t.Parallel()

	// Tag refs should not be stripped of their prefix
	result := normalizeBookmarkRef("refs/tags/v1.0")
	assert.Equal(t, "refs/tags/v1.0", result)
}
