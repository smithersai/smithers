package webhook

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeliver_SetsUserAgentAndHMACSignature(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"action":"opened"}`)
	secret := "super-secret"
	eventType := "landing_request"
	deliveryID := "delivery-1"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()

		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "Smithers-Hookshot/1.0", r.Header.Get("User-Agent"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, eventType, r.Header.Get("X-Smithers-Event"))
		assert.Equal(t, deliveryID, r.Header.Get("X-Smithers-Delivery"))
		assert.Equal(t, expectedSignature(secret, payload), r.Header.Get("X-Smithers-Signature-256"))

		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	status, body, err := Deliver(context.Background(), server.Client(), DeliveryRequest{
		URL:        server.URL,
		Secret:     secret,
		EventType:  eventType,
		DeliveryID: deliveryID,
		Payload:    payload,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusAccepted, status)
	assert.Equal(t, "ok", body)
}

func TestDefaultHTTPClient_UsesTenSecondTimeout(t *testing.T) {
	t.Parallel()

	client := DefaultHTTPClient()
	require.NotNil(t, client)
	assert.Equal(t, 10*time.Second, client.Timeout)
}

func TestCalculateNextRetry_BackoffSchedule(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.February, 22, 10, 0, 0, 0, time.UTC)

	next, ok := CalculateNextRetry(1, now)
	require.True(t, ok)
	assert.Equal(t, now.Add(1*time.Second), next)

	next, ok = CalculateNextRetry(2, now)
	require.True(t, ok)
	assert.Equal(t, now.Add(10*time.Second), next)

	next, ok = CalculateNextRetry(3, now)
	require.True(t, ok)
	assert.Equal(t, now.Add(60*time.Second), next)

	next, ok = CalculateNextRetry(4, now)
	assert.False(t, ok)
	assert.True(t, next.IsZero())
}

func TestShouldDisableWebhook_AfterTenConsecutiveFailures(t *testing.T) {
	t.Parallel()

	assert.True(t, shouldDisableWebhook([]string{
		"failed", "failed", "failed", "failed", "failed",
		"failed", "failed", "failed", "failed", "failed",
	}))

	assert.False(t, shouldDisableWebhook([]string{
		"failed", "failed", "failed", "failed", "success",
		"failed", "failed", "failed", "failed", "failed",
	}))

	assert.False(t, shouldDisableWebhook([]string{
		"failed", "failed", "failed", "failed", "failed",
		"failed", "failed", "failed", "failed",
	}))
}

func TestDeliver_EmptySecret_OmitsSignatureHeader(t *testing.T) {
	t.Parallel()

	// When no secret is configured, X-Smithers-Signature-256 must NOT be set
	// (the consumer cannot verify an unsigned payload anyway).
	payload := []byte(`{"action":"ping"}`)
	eventType := "ping"
	deliveryID := "ping-1"
	secret := ""

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sig := r.Header.Get("X-Smithers-Signature-256")
		assert.Empty(t, sig, "signature header must be absent when no secret is configured")
		// Required headers are still present.
		assert.Equal(t, eventType, r.Header.Get("X-Smithers-Event"))
		assert.Equal(t, deliveryID, r.Header.Get("X-Smithers-Delivery"))
		assert.True(t, strings.HasPrefix(r.Header.Get("User-Agent"), "Smithers-Hookshot"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	status, _, err := Deliver(context.Background(), server.Client(), DeliveryRequest{
		URL:        server.URL,
		Secret:     secret,
		EventType:  eventType,
		DeliveryID: deliveryID,
		Payload:    payload,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status)
}

func TestDeliver_Non2xxResponse_ReturnsStatusAndBody(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("service unavailable"))
	}))
	defer server.Close()

	status, body, err := Deliver(context.Background(), server.Client(), DeliveryRequest{
		URL:        server.URL,
		Secret:     "secret",
		EventType:  "push",
		DeliveryID: "delivery-2",
		Payload:    []byte(`{}`),
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, status)
	assert.Equal(t, "service unavailable", body)
}

func TestDeliver_LimitsResponseBodySize(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, strings.Repeat("x", maxResponseBodyBytes+1024))
	}))
	defer server.Close()

	status, body, err := Deliver(context.Background(), server.Client(), DeliveryRequest{
		URL:        server.URL,
		Secret:     "secret",
		EventType:  "push",
		DeliveryID: "delivery-large-body",
		Payload:    []byte(`{}`),
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, status)
	assert.Len(t, body, maxResponseBodyBytes)
}

func TestDeliver_SSRFBlocked(t *testing.T) {
	t.Parallel()

	var called atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	status, body, err := Deliver(context.Background(), nil, DeliveryRequest{
		URL:        server.URL,
		Secret:     "secret",
		EventType:  "push",
		DeliveryID: "delivery-ssrf",
		Payload:    []byte(`{}`),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "restricted IP")
	assert.Equal(t, 0, status)
	assert.Empty(t, body)
	assert.False(t, called.Load())
}

func expectedSignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyPayloadSignature(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"event":"ping"}`)
	secret := "hook-secret"
	signature := expectedSignature(secret, payload)

	assert.True(t, VerifyPayloadSignature(secret, payload, signature))
	assert.False(t, VerifyPayloadSignature(secret, payload, ""))
	assert.False(t, VerifyPayloadSignature(secret, payload, "sha256=deadbeef"))
	assert.False(t, VerifyPayloadSignature(secret, payload, "bad-prefix"))
	assert.False(t, VerifyPayloadSignature("", payload, signature))
}

func TestWebhook_TimingAttack_ConstantTimeCompare(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("delivery.go")
	require.NoError(t, err)
	assert.Contains(t, string(source), "hmac.Equal(")
}
