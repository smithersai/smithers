package services

import (
	"testing"
	"unicode/utf8"
)

// truncateBody documents that it truncates on a UTF-8 rune boundary; slicing at a
// raw byte offset would split a multi-byte rune and emit invalid UTF-8 into
// mention notifications and emails.
func TestTruncateBodyKeepsValidUTF8(t *testing.T) {
	// "é" is two bytes (0xC3 0xA9); truncating "aése" to 2 bytes lands mid-"é".
	if got := truncateBody("aése", 2); got != "a" || !utf8.ValidString(got) {
		t.Fatalf("truncateBody(\"aése\", 2) = %q (valid=%v); want \"a\"", got, utf8.ValidString(got))
	}
	if got := truncateBody("hello", 3); got != "hel" {
		t.Fatalf("ascii truncate = %q; want \"hel\"", got)
	}
	if got := truncateBody("hi", 5); got != "hi" {
		t.Fatalf("no-op truncate = %q; want \"hi\"", got)
	}
}
