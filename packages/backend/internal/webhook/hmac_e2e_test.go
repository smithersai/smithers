package webhook

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// capturedRequest stores headers and body from an inbound webhook POST.
type capturedRequest struct {
	Method      string
	UserAgent   string
	EventType   string
	DeliveryID  string
	Signature   string
	ContentType string
	Body        []byte
}

// newMockReceiver creates a test HTTP server that captures the last inbound request.
func newMockReceiver(t *testing.T) (*httptest.Server, *capturedRequest, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	captured := &capturedRequest{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		mu.Lock()
		*captured = capturedRequest{
			Method:      r.Method,
			UserAgent:   r.Header.Get("User-Agent"),
			EventType:   r.Header.Get("X-Smithers-Event"),
			DeliveryID:  r.Header.Get("X-Smithers-Delivery"),
			Signature:   r.Header.Get("X-Smithers-Signature-256"),
			ContentType: r.Header.Get("Content-Type"),
			Body:        body,
		}
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	return srv, captured, &mu
}

// verifyHMACSHA256 independently computes the expected HMAC signature.
func verifyHMACSHA256(secret string, payload []byte, signature string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// TestDeliver_EndToEnd_HMACSigning verifies the complete end-to-end outbound
// delivery flow: Deliver() → HTTP POST → receiver verifies HMAC-SHA256.
// This test uses a local httptest.Server that acts as the mock webhook receiver
// and independently computes the HMAC to validate the signature header.
func TestDeliver_EndToEnd_HMACSigning(t *testing.T) {
	t.Parallel()

	secret := "e2e-hmac-secret"
	eventType := "issues"
	deliveryID := "e2e-delivery-001"
	payload := []byte(`{"action":"opened","issue":{"id":1,"number":1,"title":"Bug","state":"open"}}`)

	srv, captured, mu := newMockReceiver(t)
	defer srv.Close()

	statusCode, body, err := Deliver(context.Background(), srv.Client(), DeliveryRequest{
		URL:        srv.URL,
		Secret:     secret,
		EventType:  eventType,
		DeliveryID: deliveryID,
		Payload:    payload,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, statusCode)
	assert.Equal(t, "", body)

	mu.Lock()
	req := *captured
	mu.Unlock()

	// Verify all required headers.
	assert.Equal(t, "POST", req.Method)
	assert.Equal(t, "Smithers-Hookshot/1.0", req.UserAgent)
	assert.Equal(t, "application/json", req.ContentType)
	assert.Equal(t, eventType, req.EventType)
	assert.Equal(t, deliveryID, req.DeliveryID)

	// HMAC-SHA256 signature must be present and correct.
	require.NotEmpty(t, req.Signature, "X-Smithers-Signature-256 must be present when secret is set")
	assert.True(t, verifyHMACSHA256(secret, payload, req.Signature),
		"HMAC signature should verify against secret and payload")

	// Signature format: sha256=<64 hex chars>
	assert.Regexp(t, `^sha256=[0-9a-f]{64}$`, req.Signature)

	// Body must exactly match the payload.
	assert.Equal(t, payload, req.Body)
}

// TestDeliver_EndToEnd_LandingRequestPayload verifies delivery with a
// structured landing_request payload.
func TestDeliver_EndToEnd_LandingRequestPayload(t *testing.T) {
	t.Parallel()

	secret := "landing-secret"
	landingPayload := map[string]any{
		"action": "opened",
		"landing_request": map[string]any{
			"number":          1,
			"title":           "Add feature",
			"state":           "open",
			"change_ids":      []string{"kabc123"},
			"target_bookmark": "main",
			"conflict_status": "clean",
			"stack_size":      1,
		},
		"repository": map[string]any{"id": 1, "name": "demo", "full_name": "alice/demo"},
		"sender":     map[string]any{"id": 9, "login": "alice"},
	}

	payload, err := json.Marshal(landingPayload)
	require.NoError(t, err)

	srv, captured, mu := newMockReceiver(t)
	defer srv.Close()

	statusCode, _, err := Deliver(context.Background(), srv.Client(), DeliveryRequest{
		URL:        srv.URL,
		Secret:     secret,
		EventType:  "landing_request",
		DeliveryID: "lr-delivery-001",
		Payload:    payload,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, statusCode)

	mu.Lock()
	req := *captured
	mu.Unlock()

	assert.Equal(t, "landing_request", req.EventType)
	assert.True(t, verifyHMACSHA256(secret, payload, req.Signature))

	// Verify the body is valid JSON and contains expected fields.
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(req.Body, &decoded))
	assert.Equal(t, "opened", decoded["action"])
	lr, ok := decoded["landing_request"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "main", lr["target_bookmark"])
	assert.Equal(t, "clean", lr["conflict_status"])
}

// TestDeliver_EndToEnd_NoSecret verifies that no signature header is sent when
// no secret is configured (receiver should not attempt verification).
func TestDeliver_EndToEnd_NoSecret(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"action":"ping"}`)

	srv, captured, mu := newMockReceiver(t)
	defer srv.Close()

	statusCode, _, err := Deliver(context.Background(), srv.Client(), DeliveryRequest{
		URL:        srv.URL,
		Secret:     "", // no secret
		EventType:  "ping",
		DeliveryID: "ping-nosecret-001",
		Payload:    payload,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, statusCode)

	mu.Lock()
	req := *captured
	mu.Unlock()

	assert.Empty(t, req.Signature,
		"X-Smithers-Signature-256 must be absent when no secret is configured")
	assert.Equal(t, "ping", req.EventType)
	assert.Equal(t, "ping-nosecret-001", req.DeliveryID)
}

// TestDeliver_EndToEnd_SignatureChangesWithPayload verifies that even a
// single-byte change in the payload produces a different HMAC signature.
func TestDeliver_EndToEnd_SignatureChangesWithPayload(t *testing.T) {
	t.Parallel()

	secret := "same-secret"

	payload1 := []byte(`{"action":"opened"}`)
	payload2 := []byte(`{"action":"closed"}`)

	var sig1, sig2 string

	for _, tc := range []struct {
		payload *[]byte
		sigOut  *string
	}{
		{&payload1, &sig1},
		{&payload2, &sig2},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.ReadAll(r.Body) //nolint:errcheck
			r.Body.Close()
			*tc.sigOut = r.Header.Get("X-Smithers-Signature-256")
			w.WriteHeader(http.StatusOK)
		}))

		_, _, err := Deliver(context.Background(), srv.Client(), DeliveryRequest{
			URL:        srv.URL,
			Secret:     secret,
			EventType:  "issues",
			DeliveryID: "delivery-x",
			Payload:    *tc.payload,
		})
		srv.Close()
		require.NoError(t, err)
	}

	require.NotEmpty(t, sig1)
	require.NotEmpty(t, sig2)
	assert.NotEqual(t, sig1, sig2,
		"different payloads must produce different HMAC signatures")
}

// TestDeliver_EndToEnd_SignatureIsDeterministic verifies that calling Deliver
// twice with the same inputs produces the same signature.
func TestDeliver_EndToEnd_SignatureIsDeterministic(t *testing.T) {
	t.Parallel()

	secret := "deterministic-secret"
	payload := []byte(`{"action":"starred","repository":{"id":1,"name":"demo"}}`)

	var sigs [2]string
	for i := 0; i < 2; i++ {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.ReadAll(r.Body) //nolint:errcheck
			r.Body.Close()
			sigs[i] = r.Header.Get("X-Smithers-Signature-256")
			w.WriteHeader(http.StatusOK)
		}))

		_, _, err := Deliver(context.Background(), srv.Client(), DeliveryRequest{
			URL:        srv.URL,
			Secret:     secret,
			EventType:  "star",
			DeliveryID: "delivery-dupe",
			Payload:    payload,
		})
		srv.Close()
		require.NoError(t, err)
	}

	assert.Equal(t, sigs[0], sigs[1],
		"identical inputs must produce identical HMAC signatures")
}
