package webhook

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func BenchmarkDeliver_WithSignature(b *testing.B) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	payload, _ := json.Marshal(map[string]any{
		"action": "opened",
		"issue": map[string]any{
			"id":     1,
			"number": 42,
			"title":  "Benchmark test issue",
			"state":  "open",
		},
		"repository": map[string]any{
			"id":   1,
			"name": "test-repo",
		},
	})

	req := DeliveryRequest{
		URL:        server.URL,
		Secret:     "whsec_benchmark_secret_key_12345",
		EventType:  "issues",
		DeliveryID: "bench-delivery-001",
		Payload:    payload,
	}

	client := &http.Client{Timeout: 5 * time.Second}
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		statusCode, _, err := Deliver(ctx, client, req)
		if err != nil {
			b.Fatal(err)
		}
		if statusCode != http.StatusOK {
			b.Fatalf("unexpected status: %d", statusCode)
		}
	}
}

func BenchmarkDeliver_WithoutSignature(b *testing.B) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	payload := []byte(`{"event":"push","repo":"test/repo"}`)

	req := DeliveryRequest{
		URL:        server.URL,
		Secret:     "",
		EventType:  "push",
		DeliveryID: "bench-delivery-002",
		Payload:    payload,
	}

	client := &http.Client{Timeout: 5 * time.Second}
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		statusCode, _, err := Deliver(ctx, client, req)
		if err != nil {
			b.Fatal(err)
		}
		if statusCode != http.StatusOK {
			b.Fatalf("unexpected status: %d", statusCode)
		}
	}
}

func BenchmarkSignPayload_Parallel(b *testing.B) {
	secret := "whsec_test_secret_key_12345"
	payload := []byte(`{"event":"push","repo":"test/repo","commits":[{"id":"abc123","message":"fix: resolve auth race condition"}]}`)

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			sig := signPayload(secret, payload)
			if sig == "" {
				b.Fatal("expected signature")
			}
		}
	})
}

func BenchmarkCalculateNextRetry(b *testing.B) {
	now := time.Now().UTC()

	b.Run("FirstRetry", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = CalculateNextRetry(1, now)
		}
	})

	b.Run("SecondRetry", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = CalculateNextRetry(2, now)
		}
	})

	b.Run("ThirdRetry", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = CalculateNextRetry(3, now)
		}
	})

	b.Run("BeyondMaxRetries", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, _ = CalculateNextRetry(10, now)
		}
	})
}

func BenchmarkShouldDisableWebhook(b *testing.B) {
	b.Run("AllFailed", func(b *testing.B) {
		statuses := make([]string, maxFailureStreak)
		for i := range statuses {
			statuses[i] = "failed"
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = shouldDisableWebhook(statuses)
		}
	})

	b.Run("MixedStatuses", func(b *testing.B) {
		statuses := make([]string, maxFailureStreak)
		for i := range statuses {
			if i%3 == 0 {
				statuses[i] = "success"
			} else {
				statuses[i] = "failed"
			}
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = shouldDisableWebhook(statuses)
		}
	})

	b.Run("TooFewStatuses", func(b *testing.B) {
		statuses := []string{"failed", "failed", "failed"}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = shouldDisableWebhook(statuses)
		}
	})
}
