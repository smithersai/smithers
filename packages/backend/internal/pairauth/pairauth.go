package pairauth

import (
	"crypto/sha256"
	"encoding/hex"
)

// TokenHash returns the sha256 hex digest of a raw Pair share token, matching
// the storage recipe used for access tokens (see internal/services/auth.go).
func TokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
