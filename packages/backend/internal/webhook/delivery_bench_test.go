package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func BenchmarkSignPayload_SmallPayload(b *testing.B) {
	secret := "whsec_test_secret_key_12345"
	payload := []byte(`{"event":"push","repo":"test/repo"}`)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sig := signPayload(secret, payload)
		if sig == "" {
			b.Fatal("expected signature")
		}
	}
}

func BenchmarkSignPayload_MediumPayload(b *testing.B) {
	secret := "whsec_test_secret_key_12345"
	// ~1KB payload
	payload := make([]byte, 1024)
	for i := range payload {
		payload[i] = byte('a' + (i % 26))
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sig := signPayload(secret, payload)
		if sig == "" {
			b.Fatal("expected signature")
		}
	}
}

func BenchmarkSignPayload_LargePayload(b *testing.B) {
	secret := "whsec_test_secret_key_12345"
	// ~10KB payload
	payload := make([]byte, 10*1024)
	for i := range payload {
		payload[i] = byte('a' + (i % 26))
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sig := signPayload(secret, payload)
		if sig == "" {
			b.Fatal("expected signature")
		}
	}
}

func BenchmarkHMACSHA256_Compare(b *testing.B) {
	secret := "whsec_test_secret_key_12345"
	payload := []byte(`{"event":"push","repo":"test/repo"}`)
	key := []byte(secret)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		mac := hmac.New(sha256.New, key)
		mac.Write(payload)
		sig := hex.EncodeToString(mac.Sum(nil))
		if sig == "" {
			b.Fatal("expected signature")
		}
	}
}
