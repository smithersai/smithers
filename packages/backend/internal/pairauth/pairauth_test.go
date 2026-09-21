package pairauth

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseKeys(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want []string
	}{
		{name: "empty", raw: "", want: nil},
		{name: "whitespace only", raw: " \t\n ,,, ", want: nil},
		{name: "single key", raw: "secret1", want: []string{"secret1"}},
		{name: "comma separated", raw: "a,b,c", want: []string{"a", "b", "c"}},
		{name: "space separated", raw: "a b c", want: []string{"a", "b", "c"}},
		{name: "newline and tab separated", raw: "a\nb\tc", want: []string{"a", "b", "c"}},
		{name: "mixed separators with padding", raw: " a, b\n\tc ,", want: []string{"a", "b", "c"}},
		{name: "consecutive separators collapse", raw: "a,,  ,b", want: []string{"a", "b"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, ParseKeys(tt.raw))
		})
	}
}

func TestKeysFromEnv(t *testing.T) {
	t.Setenv("SMITHERS_PAIR_ACCESS_KEYS", "k1, k2\nk3")
	assert.Equal(t, []string{"k1", "k2", "k3"}, KeysFromEnv())

	t.Setenv("SMITHERS_PAIR_ACCESS_KEYS", "")
	assert.Nil(t, KeysFromEnv())
}

func TestRequestKey(t *testing.T) {
	t.Parallel()

	t.Run("header wins over query", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state?key=querykey", nil)
		r.Header.Set("X-Pair-Key", "headerkey")
		assert.Equal(t, "headerkey", RequestKey(r))
	})

	t.Run("falls back to query param", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state?key=querykey", nil)
		assert.Equal(t, "querykey", RequestKey(r))
	})

	t.Run("missing everywhere is empty", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state", nil)
		assert.Equal(t, "", RequestKey(r))
	})
}

func TestAuthorizedKey(t *testing.T) {
	t.Parallel()

	keys := []string{"alpha", "beta"}

	tests := []struct {
		name string
		key  string
		keys []string
		want bool
	}{
		// No configured keys FAILS CLOSED unless SMITHERS_PAIR_ALLOW_OPEN is
		// explicitly set (unset in this test env). See TestOpenModeAllowed.
		{name: "no keys configured denies any key by default", key: "anything", keys: nil, want: false},
		{name: "no keys configured denies empty key by default", key: "", keys: []string{}, want: false},

		{name: "exact match first key", key: "alpha", keys: keys, want: true},
		{name: "exact match second key", key: "beta", keys: keys, want: true},
		{name: "wrong key rejected", key: "gamma", keys: keys, want: false},
		{name: "empty key rejected when keys configured", key: "", keys: keys, want: false},

		// Tampering / near-miss variants must not authorize.
		{name: "prefix of valid key rejected", key: "alph", keys: keys, want: false},
		{name: "valid key with suffix rejected", key: "alphaX", keys: keys, want: false},
		{name: "case-tampered key rejected", key: "Alpha", keys: keys, want: false},
		{name: "whitespace-padded key rejected", key: " alpha", keys: keys, want: false},
		{name: "unicode lookalike rejected", key: "alphа", keys: keys, want: false}, // Cyrillic 'а'
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, AuthorizedKey(tt.key, tt.keys))
		})
	}
}

func TestOpenModeAllowed(t *testing.T) {
	t.Setenv("SMITHERS_PAIR_ALLOW_OPEN", "")
	assert.False(t, OpenModeAllowed(), "unset fails closed")
	t.Setenv("SMITHERS_PAIR_ALLOW_OPEN", "false")
	assert.False(t, OpenModeAllowed(), "false fails closed")
	t.Setenv("SMITHERS_PAIR_ALLOW_OPEN", "true")
	assert.True(t, OpenModeAllowed(), "true opts into open mode")
	assert.True(t, AuthorizedKey("anything", nil), "open mode allows any key when no keys configured")
}

func TestAuthorizedRequest(t *testing.T) {
	t.Parallel()

	keys := []string{"secret"}

	t.Run("authorized via header", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state", nil)
		r.Header.Set("X-Pair-Key", "secret")
		assert.True(t, AuthorizedRequest(r, keys))
	})

	t.Run("authorized via query", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state?key=secret", nil)
		assert.True(t, AuthorizedRequest(r, keys))
	})

	t.Run("rejected without key", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state", nil)
		assert.False(t, AuthorizedRequest(r, keys))
	})

	t.Run("rejected with wrong key in both places", func(t *testing.T) {
		t.Parallel()
		r := httptest.NewRequest("GET", "/api/pair/state?key=nope", nil)
		r.Header.Set("X-Pair-Key", "alsono")
		assert.False(t, AuthorizedRequest(r, keys))
	})

	t.Run("tampered header does not fall through to valid query key", func(t *testing.T) {
		t.Parallel()
		// Header takes precedence; a present-but-wrong header must fail even
		// if the query string carries a valid key.
		r := httptest.NewRequest("GET", "/api/pair/state?key=secret", nil)
		r.Header.Set("X-Pair-Key", "wrong")
		assert.False(t, AuthorizedRequest(r, keys))
	})
}

// Regression: AuthorizedKey used ==, which leaks key material through response
// timing. The comparison is now constant-time (crypto/subtle) and evaluates
// every configured key with no early return. These cases pin the behavioral
// contract around that implementation (length mismatches, match at any
// position in a longer key list).
func TestAuthorizedKey_ConstantTimeBehavior(t *testing.T) {
	t.Parallel()

	keys := []string{"key-one", "key-two", "key-three", "key-four"}

	assert.True(t, AuthorizedKey("key-one", keys), "match at first position")
	assert.True(t, AuthorizedKey("key-three", keys), "match at middle position")
	assert.True(t, AuthorizedKey("key-four", keys), "match at last position")
	assert.False(t, AuthorizedKey("key-onee", keys), "longer candidate must not match")
	assert.False(t, AuthorizedKey("key-on", keys), "shorter candidate must not match")
	assert.False(t, AuthorizedKey("aaa-aaa", keys), "same-length non-match rejected")
}
