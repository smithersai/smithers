package services

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	sandboxTokenPrefix     = "smithers_sandbox_"
	sandboxTokenSecretEnv  = "SMITHERS_SANDBOX_TOKEN_SECRET"
	defaultSandboxTokenTTL = 15 * time.Minute
)

// errSandboxSecretMissing is returned when SMITHERS_SANDBOX_TOKEN_SECRET is
// unset or blank. There is intentionally no hardcoded fallback: an unset
// secret is a fatal misconfiguration that must be caught at startup (see
// config.ValidateServerStartup).
var errSandboxSecretMissing = errors.New(sandboxTokenSecretEnv + " is not set")

// IssueSandboxToken issues a short-lived signed token for sandbox -> internal API calls.
func IssueSandboxToken(workflowRunID int64) (string, error) {
	return issueSandboxTokenWithExpiry(workflowRunID, time.Now().UTC().Add(defaultSandboxTokenTTL))
}

func issueSandboxTokenWithExpiry(workflowRunID int64, expiresAt time.Time) (string, error) {
	if workflowRunID <= 0 {
		return "", fmt.Errorf("workflow run id must be positive")
	}

	payload := fmt.Sprintf("%d:%d", workflowRunID, expiresAt.Unix())
	payloadEncoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	signatureEncoded, err := signSandboxTokenPayload(payloadEncoded)
	if err != nil {
		return "", err
	}

	return sandboxTokenPrefix + payloadEncoded + "." + signatureEncoded, nil
}

// ValidateSandboxToken validates a sandbox token and returns the bound workflow run ID.
func ValidateSandboxToken(token string) (int64, error) {
	trimmed := strings.TrimSpace(token)
	if !strings.HasPrefix(trimmed, sandboxTokenPrefix) {
		return 0, errors.New("invalid sandbox token")
	}

	parts := strings.Split(strings.TrimPrefix(trimmed, sandboxTokenPrefix), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return 0, errors.New("invalid sandbox token")
	}

	payloadEncoded := parts[0]
	signatureEncoded := parts[1]

	expectedSignature, err := signSandboxTokenPayload(payloadEncoded)
	if err != nil {
		return 0, err
	}
	if !hmac.Equal([]byte(expectedSignature), []byte(signatureEncoded)) {
		return 0, errors.New("invalid sandbox token")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadEncoded)
	if err != nil {
		return 0, errors.New("invalid sandbox token")
	}

	payloadParts := strings.Split(string(payloadBytes), ":")
	if len(payloadParts) != 2 {
		return 0, errors.New("invalid sandbox token")
	}

	workflowRunID, err := strconv.ParseInt(payloadParts[0], 10, 64)
	if err != nil || workflowRunID <= 0 {
		return 0, errors.New("invalid sandbox token")
	}

	expiryUnix, err := strconv.ParseInt(payloadParts[1], 10, 64)
	if err != nil {
		return 0, errors.New("invalid sandbox token")
	}

	if time.Now().UTC().Unix() > expiryUnix {
		return 0, errors.New("sandbox token expired")
	}

	return workflowRunID, nil
}

func signSandboxTokenPayload(payload string) (string, error) {
	secret, err := sandboxTokenSecret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// sandboxTokenSecret returns the HMAC signing secret for sandbox tokens. It
// never falls back to a hardcoded default: an unset secret returns
// errSandboxSecretMissing so the misconfiguration surfaces loudly.
func sandboxTokenSecret() ([]byte, error) {
	secret := strings.TrimSpace(os.Getenv(sandboxTokenSecretEnv))
	if secret == "" {
		return nil, errSandboxSecretMissing
	}
	return []byte(secret), nil
}
