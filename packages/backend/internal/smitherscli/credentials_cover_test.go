package smitherscli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func credentialsCovStorePath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", path)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	return path
}

func TestCredentials_Cov_TestStoreLifecycle(t *testing.T) {
	path := credentialsCovStorePath(t)

	if err := StoreToken(" Example.COM ", " token-value \n"); err != nil {
		t.Fatalf("StoreToken returned error: %v", err)
	}
	if got := LoadStoredToken("EXAMPLE.com"); got != "token-value" {
		t.Fatalf("LoadStoredToken normalized host = %q", got)
	}
	data, err := readTestStore(path)
	if err != nil {
		t.Fatalf("readTestStore returned error: %v", err)
	}
	if data["example.com"] != "token-value" {
		t.Fatalf("stored credential map = %#v", data)
	}
	if deleted := DeleteStoredToken("example.com"); !deleted {
		t.Fatal("DeleteStoredToken did not delete existing token")
	}
	if deleted := DeleteStoredToken("example.com"); deleted {
		t.Fatal("DeleteStoredToken reported deleting missing token")
	}
	if got := LoadStoredToken("example.com"); got != "" {
		t.Fatalf("LoadStoredToken after delete = %q", got)
	}

	if err := StoreToken(" \t ", "x"); err == nil || !strings.Contains(err.Error(), "Hostname is required") {
		t.Fatalf("StoreToken blank host error = %v", err)
	}
	if got := LoadStoredToken(""); got != "" {
		t.Fatalf("LoadStoredToken blank host = %q", got)
	}
	if deleted := DeleteStoredToken(""); deleted {
		t.Fatal("DeleteStoredToken blank host reported true")
	}

	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readTestStore(path); err == nil || !strings.Contains(err.Error(), "Invalid credential store file") {
		t.Fatalf("readTestStore invalid JSON error = %v", err)
	}
	if err := StoreToken("example.com", "new"); err == nil || !strings.Contains(err.Error(), "Invalid credential store file") {
		t.Fatalf("StoreToken invalid store error = %v", err)
	}
	if got := LoadStoredToken("example.com"); got != "" {
		t.Fatalf("LoadStoredToken invalid store = %q", got)
	}
}

func TestCredentials_Cov_ErrorClassificationAndUnavailableBackend(t *testing.T) {
	if got := (&SecureStorageUnavailableError{Message: "custom unavailable"}).Error(); got != "custom unavailable" {
		t.Fatalf("custom SecureStorageUnavailableError = %q", got)
	}
	if got := (&SecureStorageUnavailableError{}).Error(); !strings.Contains(got, "Secure credential storage is unavailable") {
		t.Fatalf("default SecureStorageUnavailableError = %q", got)
	}

	if normalized, err := normalizeCredentialHost(" Example.COM "); err != nil || normalized != "example.com" {
		t.Fatalf("normalizeCredentialHost = %q, %v", normalized, err)
	}
	if _, err := normalizeCredentialHost(""); err == nil || !strings.Contains(err.Error(), "Hostname is required") {
		t.Fatalf("normalizeCredentialHost blank error = %v", err)
	}

	for _, text := range []string{"could not be found", "item not found", "cannot find credential"} {
		if !isCredentialMissingText(text) {
			t.Fatalf("isCredentialMissingText(%q) = false", text)
		}
	}
	if isCredentialMissingText("permission denied") {
		t.Fatal("isCredentialMissingText misclassified permission error")
	}
	if got := commandOutputText(nil); got != "" {
		t.Fatalf("commandOutputText(nil) = %q", got)
	}
	if got := commandOutputText(errors.New("plain failure")); got != "plain failure" {
		t.Fatalf("commandOutputText(plain) = %q", got)
	}
	cmd := exec.Command("/bin/sh", "-c", "printf 'not found in vault' >&2; exit 44")
	_, err := cmd.Output()
	if err == nil {
		t.Fatal("expected failing command")
	}
	if !strings.Contains(commandOutputText(err), "not found in vault") {
		t.Fatalf("commandOutputText(exit) = %q", commandOutputText(err))
	}
	if !isMissingCredentialError(err) {
		t.Fatalf("isMissingCredentialError(exit 44) = false for %v", err)
	}
	if isMissingCredentialError(errors.New("access denied")) {
		t.Fatal("isMissingCredentialError misclassified generic error")
	}

	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if backend := resolveCredentialBackend(); backend != nil {
		t.Fatalf("resolveCredentialBackend disabled = %#v", backend)
	}
	if err := StoreToken("example.com", "token"); err == nil {
		t.Fatal("StoreToken succeeded without a backend")
	} else {
		var unavailable *SecureStorageUnavailableError
		if !errors.As(err, &unavailable) {
			t.Fatalf("StoreToken no backend error type = %T %v", err, err)
		}
	}
	if got := LoadStoredToken("example.com"); got != "" {
		t.Fatalf("LoadStoredToken no backend = %q", got)
	}
	if deleted := DeleteStoredToken("example.com"); deleted {
		t.Fatal("DeleteStoredToken no backend reported true")
	}
}
