package auth

import (
	"strings"
	"testing"
	"time"
)

// buildTestKeyAuthFixture generates a valid EIP-4361 message, signature, and
// expected wallet address for use in benchmarks. The fixture is built once
// per benchmark and reused across iterations.
func buildTestKeyAuthFixture(tb testing.TB) (message, signature, walletAddress string) {
	tb.Helper()

	privateKey, err := testKeyFromHex("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f9f6e2b7fbc1f8f9af")
	if err != nil {
		tb.Fatal(err)
	}

	expectedAddress := keyAuthAddress(privateKey.PubKey())
	nonce := "a1b2c3d4"
	issuedAt := time.Date(2026, time.February, 19, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)
	msg := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")

	hash := keyAuthTextHash([]byte(msg))
	sig, err := testSign(hash, privateKey)
	if err != nil {
		tb.Fatal(err)
	}

	return msg, testHexEncode(sig), expectedAddress
}

func BenchmarkKeyAuthVerifier_Verify(b *testing.B) {
	message, signature, _ := buildTestKeyAuthFixture(b)
	verifier := NewKeyAuthVerifier()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := verifier.Verify(message, signature, "localhost:4000")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkKeyAuthVerifier_Verify_Parallel(b *testing.B) {
	message, signature, _ := buildTestKeyAuthFixture(b)
	verifier := NewKeyAuthVerifier()

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _, err := verifier.Verify(message, signature, "localhost:4000")
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkParseKeyAuthMessage(b *testing.B) {
	address := "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
	message := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		address,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: abc123",
		"Issued At: 2026-02-19T12:00:00Z",
	}, "\n")

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := parseKeyAuthMessage(message)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseKeyAuthMessage_InvalidInput(b *testing.B) {
	b.Run("TooShort", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = parseKeyAuthMessage("single line")
		}
	})

	b.Run("BadDomainLine", func(b *testing.B) {
		message := strings.Join([]string{
			"not a valid domain line",
			"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
			"Nonce: abc123",
		}, "\n")

		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = parseKeyAuthMessage(message)
		}
	})

	b.Run("InvalidAddress", func(b *testing.B) {
		message := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			"not-a-valid-address",
			"Nonce: abc123",
		}, "\n")

		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = parseKeyAuthMessage(message)
		}
	})
}

func BenchmarkKeyAuthVerifier_DomainMismatch(b *testing.B) {
	message, signature, _ := buildTestKeyAuthFixture(b)
	verifier := NewKeyAuthVerifier()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = verifier.Verify(message, signature, "wrong-domain.com")
	}
}
