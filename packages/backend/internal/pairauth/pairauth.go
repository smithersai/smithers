package pairauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// Level is the access level granted by a Pair share link. A view link may read
// a room; an edit link may additionally mutate it and drive the shared agent.
type Level string

const (
	LevelView Level = "view"
	LevelEdit Level = "edit"
)

// LevelSatisfies reports whether a grant at level `grant` is sufficient for an
// operation that wants at least level `want`. Edit implies view; view never
// implies edit.
func LevelSatisfies(grant, want Level) bool {
	switch want {
	case LevelView:
		return grant == LevelView || grant == LevelEdit
	case LevelEdit:
		return grant == LevelEdit
	default:
		return false
	}
}

// TokenHash returns the sha256 hex digest of a raw Pair share token, matching
// the storage recipe used for access tokens (see internal/services/auth.go).
func TokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// KeysFromEnv reads the comma/space-separated Pair access key list. When the
// list is empty, Pair access FAILS CLOSED unless open mode is explicitly
// enabled via SMITHERS_PAIR_ALLOW_OPEN (see OpenModeAllowed).
func KeysFromEnv() []string {
	return ParseKeys(os.Getenv("SMITHERS_PAIR_ACCESS_KEYS"))
}

// OpenModeAllowed reports whether Pair may run with NO configured access
// keys. This is a local/dev-only escape hatch that must be opted into
// explicitly by setting SMITHERS_PAIR_ALLOW_OPEN to a truthy value
// ("1", "t", "true", ...). Unset, empty, "false", or any unparseable value
// fails CLOSED so a missing/absent SMITHERS_PAIR_ACCESS_KEYS secret cannot
// silently expose every room's pair_state on the public realtime gateway.
func OpenModeAllowed() bool {
	v, err := strconv.ParseBool(strings.TrimSpace(os.Getenv("SMITHERS_PAIR_ALLOW_OPEN")))
	return err == nil && v
}

func ParseKeys(raw string) []string {
	var keys []string
	for _, k := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	}) {
		if k = strings.TrimSpace(k); k != "" {
			keys = append(keys, k)
		}
	}
	return keys
}

func RequestKey(r *http.Request) string {
	key := r.Header.Get("X-Pair-Key")
	if key == "" {
		key = r.URL.Query().Get("key")
	}
	return key
}

func AuthorizedRequest(r *http.Request, keys []string) bool {
	return AuthorizedKey(RequestKey(r), keys)
}

func AuthorizedKey(key string, keys []string) bool {
	if len(keys) == 0 {
		// Fail CLOSED when no access keys are configured. Opening Pair with
		// no keys is a dev-only escape hatch that must be explicitly enabled
		// via SMITHERS_PAIR_ALLOW_OPEN; otherwise a missing/empty
		// SMITHERS_PAIR_ACCESS_KEYS would expose every room's pair_state to
		// unauthenticated callers on the public realtime gateway.
		return OpenModeAllowed()
	}
	authorized := false
	for _, allowed := range keys {
		// Constant-time comparison so an attacker cannot recover a key
		// byte-by-byte from response timing. Every candidate is compared
		// (no early return) to keep timing independent of match position.
		if subtle.ConstantTimeCompare([]byte(key), []byte(allowed)) == 1 {
			authorized = true
		}
	}
	return authorized
}
