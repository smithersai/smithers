package services

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestSandboxToken_Cov_IssueValidateAndExpiry(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "test-secret")
	token, err := issueSandboxTokenWithExpiry(77, time.Now().UTC().Add(time.Minute))
	if err != nil {
		t.Fatalf("issueSandboxTokenWithExpiry returned error: %v", err)
	}
	id, err := ValidateSandboxToken(" " + token + " ")
	if err != nil || id != 77 {
		t.Fatalf("ValidateSandboxToken = %d, %v", id, err)
	}

	expired, err := issueSandboxTokenWithExpiry(77, time.Now().UTC().Add(-time.Minute))
	if err != nil {
		t.Fatalf("issue expired token: %v", err)
	}
	if _, err := ValidateSandboxToken(expired); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired err = %v", err)
	}

	if _, err := issueSandboxTokenWithExpiry(0, time.Now()); err == nil || !strings.Contains(err.Error(), "positive") {
		t.Fatalf("invalid id err = %v", err)
	}
}

func TestSandboxToken_Cov_MalformedMissingSecretAndTampered(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "")
	if _, err := IssueSandboxToken(1); err == nil || err != errSandboxSecretMissing {
		t.Fatalf("missing secret err = %v", err)
	}

	t.Setenv(sandboxTokenSecretEnv, "test-secret")
	for _, token := range []string{
		"",
		"smithers_wrong",
		sandboxTokenPrefix + "payloadonly",
		sandboxTokenPrefix + ".sig",
		sandboxTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte("bad")) + ".sig",
	} {
		if _, err := ValidateSandboxToken(token); err == nil {
			t.Fatalf("ValidateSandboxToken(%q) succeeded unexpectedly", token)
		}
	}

	valid, err := issueSandboxTokenWithExpiry(5, time.Now().UTC().Add(time.Minute))
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	tampered := valid[:len(valid)-1] + "x"
	if _, err := ValidateSandboxToken(tampered); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("tampered err = %v", err)
	}
}
