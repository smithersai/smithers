package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	smithersUserAgent     = "Smithers-Hookshot/1.0"
	smithersSignatureName = "X-Smithers-Signature-256"
	maxFailureStreak      = 10
	maxResponseBodyBytes  = 4 << 10
)

var retrySchedule = []time.Duration{1 * time.Second, 10 * time.Second, 60 * time.Second}

// DeliveryRequest contains data needed to send a single webhook HTTP request.
type DeliveryRequest struct {
	URL        string
	Secret     string
	EventType  string
	DeliveryID string
	Payload    []byte
}

// DeliveryResult represents the result of a single webhook attempt.
type DeliveryResult struct {
	StatusCode   int
	ResponseBody string
	Err          error
	SkipRetry    bool
	Disabled     bool
}

// DefaultHTTPClient returns the webhook delivery HTTP client with spec timeout.
func DefaultHTTPClient() *http.Client {
	return SafeHTTPClient()
}

// Deliver sends a webhook payload to a destination URL.
func Deliver(ctx context.Context, client *http.Client, req DeliveryRequest) (int, string, error) {
	if client == nil {
		client = DefaultHTTPClient()
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, req.URL, bytes.NewReader(req.Payload))
	if err != nil {
		return 0, "", err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", smithersUserAgent)
	httpReq.Header.Set("X-Smithers-Event", req.EventType)
	httpReq.Header.Set("X-Smithers-Delivery", req.DeliveryID)
	if req.Secret != "" {
		httpReq.Header.Set(smithersSignatureName, signPayload(req.Secret, req.Payload))
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBodyBytes))
	if readErr != nil {
		return resp.StatusCode, "", readErr
	}

	return resp.StatusCode, storableResponseBody(string(body)), nil
}

// CalculateNextRetry returns the next retry timestamp for a failed attempt.
func CalculateNextRetry(attempt int32, now time.Time) (time.Time, bool) {
	if attempt < 1 || int(attempt) > len(retrySchedule) {
		return time.Time{}, false
	}
	return now.Add(retrySchedule[attempt-1]), true
}

func signPayload(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// VerifyPayloadSignature validates an inbound X-Smithers-Signature-256 header
// against the raw payload bytes using HMAC-SHA256.
func VerifyPayloadSignature(secret string, payload []byte, signature string) bool {
	if strings.TrimSpace(secret) == "" {
		return false
	}

	sig := strings.TrimSpace(signature)
	if sig == "" || !strings.HasPrefix(sig, "sha256=") {
		return false
	}

	providedHex := strings.TrimSpace(strings.TrimPrefix(sig, "sha256="))
	if len(providedHex) != sha256.Size*2 {
		return false
	}

	provided, err := hex.DecodeString(providedHex)
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	expected := mac.Sum(nil)

	return hmac.Equal(expected, provided)
}

func shouldDisableWebhook(recentStatuses []string) bool {
	if len(recentStatuses) < maxFailureStreak {
		return false
	}

	for i := 0; i < maxFailureStreak; i++ {
		if recentStatuses[i] != "failed" {
			return false
		}
	}

	return true
}
