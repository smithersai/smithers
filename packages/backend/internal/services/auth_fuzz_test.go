package services

import (
	"strings"
	"testing"
)

// FuzzIsValidUUID fuzzes the UUID format validator used in session key validation.
// This is security-critical because malformed session keys must be rejected without
// panics or unexpected behavior.
func FuzzIsValidUUID(f *testing.F) {
	// Valid UUID.
	f.Add("550e8400-e29b-41d4-a716-446655440000")

	// Empty string.
	f.Add("")

	// Too short.
	f.Add("550e8400")

	// Too long.
	f.Add("550e8400-e29b-41d4-a716-446655440000-extra")

	// Missing dashes.
	f.Add("550e8400e29b41d4a716446655440000")

	// Dashes in wrong positions.
	f.Add("550e-8400-e29b-41d4-a716446655440000")

	// Non-hex characters.
	f.Add("gggggggg-gggg-gggg-gggg-gggggggggggg")

	// Exactly 36 chars but invalid characters.
	f.Add("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")

	// All zeros.
	f.Add("00000000-0000-0000-0000-000000000000")

	// Uppercase hex (should still validate).
	f.Add("550E8400-E29B-41D4-A716-446655440000")

	// Null bytes.
	f.Add("\x00\x00\x00\x00\x00\x00\x00\x00-\x00\x00\x00\x00-\x00\x00\x00\x00-\x00\x00\x00\x00-\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")

	// Very long string.
	f.Add(strings.Repeat("a", 10000))

	f.Fuzz(func(t *testing.T, s string) {
		// Must never panic.
		_ = isValidUUID(s)
	})
}

// FuzzSplitScopes fuzzes the token scope splitter to ensure it handles all
// possible raw scope strings without panics.
func FuzzSplitScopes(f *testing.F) {
	// Normal comma-separated scopes.
	f.Add("repo,user,org")

	// Empty string.
	f.Add("")

	// Whitespace-only.
	f.Add("   ")

	// Single scope.
	f.Add("admin")

	// Trailing/leading commas.
	f.Add(",repo,user,")

	// Multiple consecutive commas.
	f.Add("repo,,,user,,org")

	// Very long scope string.
	f.Add(strings.Repeat("scope,", 5000))

	// Null bytes.
	f.Add("repo\x00user")

	// Unicode.
	f.Add("\u200brepo\u200b,\u200buser\u200b")

	f.Fuzz(func(t *testing.T, raw string) {
		// Must never panic.
		result := splitScopes(raw)
		// Result must always be non-nil.
		if result == nil {
			t.Error("splitScopes returned nil, expected empty slice")
		}
	})
}

// FuzzValidateCreateTokenName fuzzes the token name validator.
func FuzzValidateCreateTokenName(f *testing.F) {
	f.Add("my-token")
	f.Add("")
	f.Add("   ")
	f.Add(strings.Repeat("a", 10000))
	f.Add("\x00\x01\x02")
	f.Add("\n\r\t")

	f.Fuzz(func(t *testing.T, name string) {
		// Must never panic.
		_, _ = validateCreateTokenName(name)
	})
}

// FuzzWalletUsername fuzzes wallet address to username conversion.
// This is used during auto-registration and must handle all inputs safely.
func FuzzWalletUsername(f *testing.F) {
	// Normal wallet address.
	f.Add("0x1234567890abcdef1234567890abcdef12345678")

	// Empty string.
	f.Add("")

	// Short string.
	f.Add("0x1234")

	// Very long string.
	f.Add(strings.Repeat("a", 10000))

	// Just whitespace.
	f.Add("   ")

	f.Fuzz(func(t *testing.T, walletAddress string) {
		// Must never panic.
		candidates := walletUsernameCandidates(walletAddress)
		if len(candidates) == 0 {
			t.Errorf("walletUsernameCandidates(%q) returned no candidates", walletAddress)
		}
		// Every candidate must be a non-empty string starting with "wallet-".
		for _, candidate := range candidates {
			if !strings.HasPrefix(candidate, "wallet-") {
				t.Errorf("walletUsernameCandidates(%q) = %q, expected wallet- prefix", walletAddress, candidate)
			}
		}
	})
}

// FuzzHashOAuthStateVerifier fuzzes the OAuth state verifier hash function.
func FuzzHashOAuthStateVerifier(f *testing.F) {
	f.Add("some-state-verifier")
	f.Add("")
	f.Add(strings.Repeat("x", 10000))
	f.Add("\x00\x01\x02\x03")
	f.Add("   leading and trailing spaces   ")

	f.Fuzz(func(t *testing.T, verifier string) {
		// Must never panic.
		result := hashOAuthStateVerifier(verifier)
		// SHA-256 hex should always be 64 characters.
		if len(result) != 64 {
			t.Errorf("hashOAuthStateVerifier(%q) returned %d chars, expected 64", verifier, len(result))
		}
	})
}

// FuzzRandomHex fuzzes the random hex generator with various byte lengths.
// Negative and zero lengths must be handled safely.
func FuzzRandomHex(f *testing.F) {
	f.Add(16)
	f.Add(0)
	f.Add(1)
	f.Add(32)
	f.Add(1000)

	f.Fuzz(func(t *testing.T, bytesLen int) {
		if bytesLen < 0 || bytesLen > 100000 {
			// Skip unreasonable sizes to avoid OOM.
			return
		}
		// Must never panic.
		result := randomHex(bytesLen)
		// Result should be exactly 2*bytesLen hex characters.
		if len(result) != bytesLen*2 {
			t.Errorf("randomHex(%d) returned %d chars, expected %d", bytesLen, len(result), bytesLen*2)
		}
	})
}

// FuzzPickVerifiedEmail fuzzes the picker that selects the best verified email from a
// GitHub OAuth response.
func FuzzPickVerifiedEmail(f *testing.F) {
	f.Add("user@example.com", true, true)
	f.Add("", false, false)
	f.Add("test@test.com", false, true)
	f.Add(strings.Repeat("a", 1000)+"@example.com", true, true)
	f.Add("\x00@\x00.\x00", true, true)

	f.Fuzz(func(t *testing.T, email string, primary, verified bool) {
		emails := []GitHubEmail{
			{Email: email, Primary: primary, Verified: verified},
		}
		// Must never panic.
		_ = pickVerifiedEmail(emails)
	})
}

// FuzzFirstNonEmpty fuzzes the first-non-empty string selector.
func FuzzFirstNonEmpty(f *testing.F) {
	f.Add("hello", "world")
	f.Add("", "")
	f.Add("   ", "value")
	f.Add("", "   ")
	f.Add(strings.Repeat("x", 10000), "")

	f.Fuzz(func(t *testing.T, a, b string) {
		// Must never panic.
		_ = firstNonEmpty(a, b)
	})
}
