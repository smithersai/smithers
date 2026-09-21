package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizeRepoPermission(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected string
	}{
		{"admin", "admin"},
		{"ADMIN", "admin"},
		{"  write  ", "write"},
		{"Read", "read"},
		{"", ""},
		{"unknown", "unknown"},
	}

	for _, tt := range tests {
		result := normalizeRepoPermission(tt.input)
		assert.Equal(t, tt.expected, result, "input: %q", tt.input)
	}
}

func TestRepoPermissionRank(t *testing.T) {
	t.Parallel()

	tests := []struct {
		permission string
		expected   int
	}{
		{"admin", 3},
		{"write", 2},
		{"read", 1},
		{"", 0},
		{"unknown", 0},
		{"ADMIN", 3},
		{"  write  ", 2},
	}

	for _, tt := range tests {
		rank := repoPermissionRank(tt.permission)
		assert.Equal(t, tt.expected, rank, "permission: %q", tt.permission)
	}
}

func TestHighestRepoPermission_SingleValue(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("admin"))
	assert.Equal(t, "write", highestRepoPermission("write"))
	assert.Equal(t, "read", highestRepoPermission("read"))
	assert.Equal(t, "", highestRepoPermission(""))
}

func TestHighestRepoPermission_MultipleValues(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("read", "admin"))
	assert.Equal(t, "write", highestRepoPermission("read", "write"))
	assert.Equal(t, "admin", highestRepoPermission("write", "admin", "read"))
	assert.Equal(t, "read", highestRepoPermission("", "read", ""))
}

func TestHighestRepoPermission_EmptyList(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "", highestRepoPermission())
}

func TestHighestRepoPermission_AllEmpty(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "", highestRepoPermission("", "", ""))
}

func TestHighestRepoPermission_MixedCase(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("READ", "Admin", "write"))
}
