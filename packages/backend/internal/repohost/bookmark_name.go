package repohost

import (
	"fmt"
	"strings"
)

// ValidateBookmarkName enforces git refname syntax for "refs/heads/<name>"
// (the rules of git-check-ref-format, plus git's refusal of "HEAD" as a
// branch name). jj itself accepts any bookmark name, but every Smithers
// bookmark must export as a git branch; a name that fails these rules is
// recorded in jj and then silently fails to export, leaving the API
// advertising a branch that can never be fetched or mirrored to GitHub.
func ValidateBookmarkName(name string) error {
	if name == "" {
		return fmt.Errorf("bookmark name is required")
	}
	if name == "@" || name == "HEAD" {
		return fmt.Errorf("bookmark name %q is reserved by git", name)
	}
	if strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") {
		return fmt.Errorf("bookmark name must not start or end with '/'")
	}
	if strings.HasSuffix(name, ".") {
		return fmt.Errorf("bookmark name must not end with '.'")
	}
	if strings.Contains(name, "..") {
		return fmt.Errorf("bookmark name must not contain '..'")
	}
	if strings.Contains(name, "@{") {
		return fmt.Errorf("bookmark name must not contain '@{'")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7F {
			return fmt.Errorf("bookmark name must not contain control characters")
		}
		if strings.ContainsRune(" ~^:?*[\\", r) {
			return fmt.Errorf("bookmark name must not contain %q", r)
		}
	}
	for _, component := range strings.Split(name, "/") {
		if component == "" {
			return fmt.Errorf("bookmark name must not contain consecutive '/'")
		}
		if strings.HasPrefix(component, ".") {
			return fmt.Errorf("bookmark name components must not start with '.'")
		}
		if strings.HasSuffix(component, ".lock") {
			return fmt.Errorf("bookmark name components must not end with '.lock'")
		}
	}
	return nil
}
