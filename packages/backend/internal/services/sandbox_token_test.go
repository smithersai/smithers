package services

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// setSandboxSecret configures a non-empty signing secret for the duration of a
// test. The production code no longer falls back to a hardcoded default, so
// every test that mints or validates a token must provide one explicitly.
func setSandboxSecret(t *testing.T) {
	t.Helper()
	t.Setenv(sandboxTokenSecretEnv, "test-sandbox-token-secret")
}

func TestSandboxTokenSecret_MissingErrors(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "")
	secret, err := sandboxTokenSecret()
	if !errors.Is(err, errSandboxSecretMissing) {
		t.Fatalf("expected errSandboxSecretMissing, got %v", err)
	}
	if secret != nil {
		t.Fatalf("expected nil secret, got %q", secret)
	}
}

func TestSandboxTokenSecret_BlankErrors(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "   ")
	if _, err := sandboxTokenSecret(); !errors.Is(err, errSandboxSecretMissing) {
		t.Fatalf("expected errSandboxSecretMissing for blank secret, got %v", err)
	}
}

func TestSandboxTokenSecret_SetReturned(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "a-real-secret")
	secret, err := sandboxTokenSecret()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if string(secret) != "a-real-secret" {
		t.Fatalf("expected configured secret, got %q", secret)
	}
}

func TestIssueSandboxToken_MissingSecretErrors(t *testing.T) {
	t.Setenv(sandboxTokenSecretEnv, "")
	if _, err := IssueSandboxToken(123); !errors.Is(err, errSandboxSecretMissing) {
		t.Fatalf("expected errSandboxSecretMissing, got %v", err)
	}
}

func TestIssueAndValidateSandboxToken(t *testing.T) {
	setSandboxSecret(t)
	token, err := IssueSandboxToken(42)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if !strings.HasPrefix(token, sandboxTokenPrefix) {
		t.Fatalf("token missing prefix: %q", token)
	}
	runID, err := ValidateSandboxToken(token)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if runID != 42 {
		t.Fatalf("expected run id 42, got %d", runID)
	}
}

func TestValidateSandboxToken_Expired(t *testing.T) {
	setSandboxSecret(t)
	token, err := issueSandboxTokenWithExpiry(7, time.Now().UTC().Add(-time.Minute))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := ValidateSandboxToken(token); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}

func TestValidateSandboxToken_InvalidSignature(t *testing.T) {
	setSandboxSecret(t)
	token, err := IssueSandboxToken(9)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Flip the last character of the signature to corrupt it.
	tampered := token[:len(token)-1]
	if token[len(token)-1] == 'A' {
		tampered += "B"
	} else {
		tampered += "A"
	}
	if _, err := ValidateSandboxToken(tampered); err == nil {
		t.Fatal("expected tampered token to be rejected")
	}
}

func TestValidateSandboxToken_MissingSecretErrors(t *testing.T) {
	setSandboxSecret(t)
	token, err := IssueSandboxToken(11)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Clear the secret before validating: validation must surface the
	// misconfiguration rather than silently succeeding or panicking.
	t.Setenv(sandboxTokenSecretEnv, "")
	if _, err := ValidateSandboxToken(token); !errors.Is(err, errSandboxSecretMissing) {
		t.Fatalf("expected errSandboxSecretMissing, got %v", err)
	}
}
