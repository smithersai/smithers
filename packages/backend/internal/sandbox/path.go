package sandbox

import (
	"errors"
	"net/url"
	"strings"
)

// EscapeGuestPath validates a guest-absolute or guest-relative path and
// escapes every segment without allowing dot-segment traversal.
func EscapeGuestPath(filepath string) (string, error) {
	filepath = strings.TrimPrefix(strings.TrimSpace(filepath), "/")
	if filepath == "" {
		return "", errors.New("guest file path is required")
	}
	segments := strings.Split(filepath, "/")
	escaped := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || strings.IndexByte(segment, 0) >= 0 {
			return "", errors.New("guest file path contains an unsafe segment")
		}
		escaped = append(escaped, url.PathEscape(segment))
	}
	return strings.Join(escaped, "/"), nil
}
