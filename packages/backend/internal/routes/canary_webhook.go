package routes

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const canaryWebhookTokenPrefix = "smithers-canary-webhook"

type CanaryWebhookHandler struct {
	signingKey []byte
	Observer   CanaryWebhookReceiptObserver
	Clock      func() time.Time
}

type CanaryWebhookReceiptObserver interface {
	ObserveCanaryWebhookReceipt(receivedAt time.Time)
}

func NewCanaryWebhookHandler(signingKey string) *CanaryWebhookHandler {
	signingKey = strings.TrimSpace(signingKey)
	if signingKey == "" {
		return nil
	}
	return &CanaryWebhookHandler{signingKey: []byte(signingKey)}
}

func (h *CanaryWebhookHandler) now() time.Time {
	if h != nil && h.Clock != nil {
		return h.Clock().UTC()
	}
	return time.Now().UTC()
}

func SignCanaryWebhookToken(signingKey string) (string, error) {
	signingKey = strings.TrimSpace(signingKey)
	if signingKey == "" {
		return "", errors.New("signing key is required")
	}
	mac := hmac.New(sha256.New, []byte(signingKey))
	_, _ = mac.Write([]byte(canaryWebhookTokenPrefix))
	return canaryWebhookTokenPrefix + "." + hex.EncodeToString(mac.Sum(nil)), nil
}

func ValidateCanaryWebhookToken(signingKey, token string) bool {
	expectedToken, err := SignCanaryWebhookToken(signingKey)
	if err != nil {
		return false
	}
	if !strings.HasPrefix(token, canaryWebhookTokenPrefix+".") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expectedToken), []byte(token)) == 1
}

func (h *CanaryWebhookHandler) Receive(w http.ResponseWriter, r *http.Request) {
	if h == nil || len(h.signingKey) == 0 {
		pkgerrors.WriteError(w, pkgerrors.NotFound("canary webhook receiver is not configured"))
		return
	}
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if !ValidateCanaryWebhookToken(string(h.signingKey), token) {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("invalid canary webhook token"))
		return
	}
	if h.Observer != nil {
		h.Observer.ObserveCanaryWebhookReceipt(h.now())
	}
	w.WriteHeader(http.StatusNoContent)
}
