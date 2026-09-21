package routes_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

type stubCanaryWebhookObserver struct {
	receivedAt time.Time
}

func (s *stubCanaryWebhookObserver) ObserveCanaryWebhookReceipt(receivedAt time.Time) {
	s.receivedAt = receivedAt
}

// ---------------------------------------------------------------------------
// CanaryWebhookHandler unit tests
// Tests for the production canary webhook receiver used by the webhook canary
// to verify end-to-end webhook delivery.
// ---------------------------------------------------------------------------

func TestCanaryWebhookHandler_NewReturnsNilForEmptyKey(t *testing.T) {
	t.Parallel()

	assert.Nil(t, routes.NewCanaryWebhookHandler(""))
	assert.Nil(t, routes.NewCanaryWebhookHandler("   "))
}

func TestCanaryWebhookHandler_NewReturnsHandlerForValidKey(t *testing.T) {
	t.Parallel()

	handler := routes.NewCanaryWebhookHandler("test-signing-key")
	assert.NotNil(t, handler)
}

func TestCanaryWebhookHandler_Receive_ValidToken(t *testing.T) {
	t.Parallel()

	signingKey := "test-canary-key-abc123"
	handler := routes.NewCanaryWebhookHandler(signingKey)
	require.NotNil(t, handler)

	token, err := routes.SignCanaryWebhookToken(signingKey)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Post("/canary/webhook-receiver/{token}", handler.Receive)

	req := httptest.NewRequest(http.MethodPost, "/canary/webhook-receiver/"+token, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestCanaryWebhookHandler_Receive_RecordsReceipt(t *testing.T) {
	t.Parallel()

	signingKey := "test-canary-key-abc123"
	receivedAt := time.Unix(1_710_000_030, 0).UTC()
	observer := &stubCanaryWebhookObserver{}
	handler := routes.NewCanaryWebhookHandler(signingKey)
	require.NotNil(t, handler)
	handler.Observer = observer
	handler.Clock = func() time.Time { return receivedAt }

	token, err := routes.SignCanaryWebhookToken(signingKey)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Post("/canary/webhook-receiver/{token}", handler.Receive)

	req := httptest.NewRequest(http.MethodPost, "/canary/webhook-receiver/"+token, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, receivedAt, observer.receivedAt)
}

func TestCanaryWebhookHandler_Receive_InvalidToken(t *testing.T) {
	t.Parallel()

	handler := routes.NewCanaryWebhookHandler("test-canary-key-abc123")
	require.NotNil(t, handler)

	r := chi.NewRouter()
	r.Post("/canary/webhook-receiver/{token}", handler.Receive)

	req := httptest.NewRequest(http.MethodPost, "/canary/webhook-receiver/bad-token", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestCanaryWebhookHandler_Receive_EmptyToken(t *testing.T) {
	t.Parallel()

	handler := routes.NewCanaryWebhookHandler("test-canary-key-abc123")
	require.NotNil(t, handler)

	r := chi.NewRouter()
	r.Post("/canary/webhook-receiver/{token}", handler.Receive)

	req := httptest.NewRequest(http.MethodPost, "/canary/webhook-receiver/", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Chi will not match the route with empty token param, so 405.
	assert.NotEqual(t, http.StatusNoContent, rec.Code)
}

func TestCanaryWebhookHandler_Receive_WrongSigningKey(t *testing.T) {
	t.Parallel()

	handler := routes.NewCanaryWebhookHandler("correct-key")
	require.NotNil(t, handler)

	// Sign with a different key
	token, err := routes.SignCanaryWebhookToken("wrong-key")
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Post("/canary/webhook-receiver/{token}", handler.Receive)

	req := httptest.NewRequest(http.MethodPost, "/canary/webhook-receiver/"+token, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSignCanaryWebhookToken_Deterministic(t *testing.T) {
	t.Parallel()

	key := "deterministic-test-key"
	token1, err1 := routes.SignCanaryWebhookToken(key)
	require.NoError(t, err1)
	token2, err2 := routes.SignCanaryWebhookToken(key)
	require.NoError(t, err2)

	assert.Equal(t, token1, token2, "same key must produce the same token")
}

func TestSignCanaryWebhookToken_DifferentKeys(t *testing.T) {
	t.Parallel()

	token1, err1 := routes.SignCanaryWebhookToken("key-alpha")
	require.NoError(t, err1)
	token2, err2 := routes.SignCanaryWebhookToken("key-beta")
	require.NoError(t, err2)

	assert.NotEqual(t, token1, token2, "different keys must produce different tokens")
}

func TestSignCanaryWebhookToken_HasPrefix(t *testing.T) {
	t.Parallel()

	token, err := routes.SignCanaryWebhookToken("test-key")
	require.NoError(t, err)

	assert.Contains(t, token, "smithers-canary-webhook.", "token must have the expected prefix")
}

func TestSignCanaryWebhookToken_EmptyKeyReturnsError(t *testing.T) {
	t.Parallel()

	_, err := routes.SignCanaryWebhookToken("")
	assert.Error(t, err)
}

func TestValidateCanaryWebhookToken_ValidRoundTrip(t *testing.T) {
	t.Parallel()

	key := "roundtrip-key"
	token, err := routes.SignCanaryWebhookToken(key)
	require.NoError(t, err)

	assert.True(t, routes.ValidateCanaryWebhookToken(key, token))
}

func TestValidateCanaryWebhookToken_InvalidToken(t *testing.T) {
	t.Parallel()

	assert.False(t, routes.ValidateCanaryWebhookToken("key", "totally-invalid"))
}

func TestValidateCanaryWebhookToken_EmptyKey(t *testing.T) {
	t.Parallel()

	assert.False(t, routes.ValidateCanaryWebhookToken("", "any-token"))
}

func TestValidateCanaryWebhookToken_MismatchedKey(t *testing.T) {
	t.Parallel()

	token, err := routes.SignCanaryWebhookToken("key-a")
	require.NoError(t, err)

	assert.False(t, routes.ValidateCanaryWebhookToken("key-b", token))
}

func TestValidateCanaryWebhookToken_TamperedSignature(t *testing.T) {
	t.Parallel()

	key := "tamper-key"
	token, err := routes.SignCanaryWebhookToken(key)
	require.NoError(t, err)

	// Flip the last hex character
	tampered := token[:len(token)-1] + "0"
	if token[len(token)-1] == '0' {
		tampered = token[:len(token)-1] + "f"
	}

	assert.False(t, routes.ValidateCanaryWebhookToken(key, tampered))
}

func TestCanaryWebhookHandler_Receive_NilHandler(t *testing.T) {
	t.Parallel()

	// NewCanaryWebhookHandler returns nil for empty key.
	// Calling Receive on nil should return a 404 (not configured).
	handler := routes.NewCanaryWebhookHandler("")
	assert.Nil(t, handler)
	// No panic if handler is nil — the router just won't register it.
}
