package services

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSandboxToken_Z_InvalidPayloadBranches(t *testing.T) {
	t.Setenv("SMITHERS_SANDBOX_TOKEN_SECRET", "sandbox-secret")

	sig, err := signSandboxTokenPayload("%%%")
	require.NoError(t, err)
	_, err = ValidateSandboxToken(sandboxTokenPrefix + "%%%." + sig)
	require.ErrorContains(t, err, "invalid sandbox token")

	payload := base64.RawURLEncoding.EncodeToString([]byte("1:2:3"))
	sig, err = signSandboxTokenPayload(payload)
	require.NoError(t, err)
	_, err = ValidateSandboxToken(sandboxTokenPrefix + payload + "." + sig)
	require.ErrorContains(t, err, "invalid sandbox token")

	payload = base64.RawURLEncoding.EncodeToString([]byte("abc:9999999999"))
	sig, err = signSandboxTokenPayload(payload)
	require.NoError(t, err)
	_, err = ValidateSandboxToken(sandboxTokenPrefix + payload + "." + sig)
	require.ErrorContains(t, err, "invalid sandbox token")

	payload = base64.RawURLEncoding.EncodeToString([]byte("1:not-expiry"))
	sig, err = signSandboxTokenPayload(payload)
	require.NoError(t, err)
	_, err = ValidateSandboxToken(sandboxTokenPrefix + payload + "." + sig)
	require.ErrorContains(t, err, "invalid sandbox token")

	token, err := IssueSandboxToken(123)
	require.NoError(t, err)
	parts := strings.Split(strings.TrimPrefix(token, sandboxTokenPrefix), ".")
	require.Len(t, parts, 2)
	_, err = ValidateSandboxToken(sandboxTokenPrefix + parts[0] + ".bad")
	assert.ErrorContains(t, err, "invalid sandbox token")
}
