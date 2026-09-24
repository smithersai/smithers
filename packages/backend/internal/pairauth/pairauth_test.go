package pairauth

import "testing"

// Stored share-link rows are keyed by this digest, so the recipe must not
// change: sha256 of the raw token, lowercase hex.
func TestTokenHash(t *testing.T) {
	const want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if got := TokenHash("hello"); got != want {
		t.Fatalf("TokenHash(hello) = %s, want %s", got, want)
	}
}
