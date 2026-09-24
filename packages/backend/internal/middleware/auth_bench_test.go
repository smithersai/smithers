package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func BenchmarkExtractToken_ValidBearer(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if tok := ExtractToken(req); tok == "" {
			b.Fatal("expected token")
		}
	}
}

func BenchmarkExtractToken_InvalidToken(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer invalid")

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if tok := ExtractToken(req); tok != "" {
			b.Fatal("expected empty token")
		}
	}
}
