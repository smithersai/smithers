package auth

import (
	"strings"
	"testing"
)

// FuzzParseKeyAuthMessage fuzzes the EIP-4361 message parser to ensure it never
// panics on arbitrary input. This is security-critical because the parser processes
// untrusted input from authentication requests.
func FuzzParseKeyAuthMessage(f *testing.F) {
	// Valid-ish corpus entry (structurally correct message).
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n" +
		"\n" +
		"Sign in to Smithers\n" +
		"\n" +
		"URI: https://smithers.sh\n" +
		"Version: 1\n" +
		"Chain ID: 1\n" +
		"Nonce: abc123\n" +
		"Issued At: 2024-01-01T00:00:00Z")

	// Empty input.
	f.Add("")

	// Single line (too few lines).
	f.Add("smithers.sh wants you to sign in with your Ethereum account:")

	// Missing domain suffix.
	f.Add("smithers.sh\n0x1234567890abcdef1234567890abcdef12345678")

	// Invalid wallet address.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\nnot-a-wallet")

	// Missing required fields.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n")

	// Extremely long input.
	f.Add(strings.Repeat("a", 10000))

	// Null bytes embedded.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n\x00\x00\x00")

	// Unicode edge cases.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"\u200b\u200b\u200b")

	// All required fields but wrong version.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n" +
		"\n" +
		"URI: https://smithers.sh\n" +
		"Version: 999\n" +
		"Chain ID: 1\n" +
		"Nonce: test123\n")

	// Chain ID overflow attempt.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n" +
		"\n" +
		"URI: https://smithers.sh\n" +
		"Version: 1\n" +
		"Chain ID: 99999999999999999999999999999999999999\n" +
		"Nonce: test123\n")

	// Negative chain ID.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n" +
		"\n" +
		"URI: https://smithers.sh\n" +
		"Version: 1\n" +
		"Chain ID: -1\n" +
		"Nonce: test123\n")

	// Duplicate fields.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\n" +
		"0x1234567890abcdef1234567890abcdef12345678\n" +
		"\n" +
		"URI: https://smithers.sh\n" +
		"URI: https://evil.com\n" +
		"Version: 1\n" +
		"Version: 2\n" +
		"Chain ID: 1\n" +
		"Nonce: test123\n")

	// Windows line endings.
	f.Add("smithers.sh wants you to sign in with your Ethereum account:\r\n" +
		"0x1234567890abcdef1234567890abcdef12345678\r\n" +
		"\r\n" +
		"URI: https://smithers.sh\r\n" +
		"Version: 1\r\n" +
		"Chain ID: 1\r\n" +
		"Nonce: test\r\n")

	f.Fuzz(func(t *testing.T, message string) {
		// parseKeyAuthMessage must never panic on any input.
		_, _ = parseKeyAuthMessage(message)
	})
}

// FuzzKeyAuthVerifier_Verify fuzzes the full Verify method with arbitrary
// message, signature, and domain inputs. The signature decoding and crypto
// recovery must handle all malformed inputs gracefully.
func FuzzKeyAuthVerifier_Verify(f *testing.F) {
	verifier := NewKeyAuthVerifier()

	// Known-good shape (will fail crypto but should not panic).
	f.Add(
		"smithers.sh wants you to sign in with your Ethereum account:\n"+
			"0x1234567890abcdef1234567890abcdef12345678\n"+
			"\nURI: https://smithers.sh\nVersion: 1\nChain ID: 1\nNonce: abc123\n",
		"0x"+strings.Repeat("ab", 65),
		"smithers.sh",
	)

	// Empty inputs.
	f.Add("", "", "")
	f.Add("", "", "smithers.sh")

	// Very long signature.
	f.Add("test message", strings.Repeat("ff", 10000), "smithers.sh")

	// Non-hex signature.
	f.Add("test message", "not-hex-at-all!!!", "smithers.sh")

	// Empty domain.
	f.Add("test message", "0xdeadbeef", "")

	// Null bytes in all fields.
	f.Add("\x00\x00\x00", "\x00\x00\x00", "\x00\x00\x00")

	f.Fuzz(func(t *testing.T, message, signature, domain string) {
		// Must never panic regardless of input.
		_, _, _ = verifier.Verify(message, signature, domain)
	})
}
