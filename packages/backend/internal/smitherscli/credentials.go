package smitherscli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const credentialServiceName = "smithers-cli"

// credMarshalIndent is a seam so the defensive marshal-error branch in
// writeTestStore can be exercised (json.MarshalIndent never fails for a
// map[string]string).
var credMarshalIndent = json.MarshalIndent

type SecureStorageUnavailableError struct {
	Message string
}

func (e *SecureStorageUnavailableError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "Secure credential storage is unavailable on this system."
}

type credentialStoreBackend interface {
	Delete(host string) (bool, error)
	Get(host string) (string, error)
	Set(host, token string) error
}

func normalizeCredentialHost(host string) (string, error) {
	normalized := strings.TrimSpace(strings.ToLower(host))
	if normalized == "" {
		return "", errors.New("Hostname is required for credential storage.")
	}
	return normalized, nil
}

func readTestStore(path string) (map[string]string, error) {
	data := map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return data, nil
		}
		return nil, err
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return data, nil
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return nil, fmt.Errorf("Invalid credential store file: %s", path)
	}
	for key, value := range parsed {
		data[key] = value
	}
	return data, nil
}

func writeTestStore(path string, data map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := credMarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

type testFileBackend struct {
	path string
}

func (b testFileBackend) Delete(host string) (bool, error) {
	data, err := readTestStore(b.path)
	if err != nil {
		return false, err
	}
	_, existed := data[host]
	if existed {
		delete(data, host)
		return true, writeTestStore(b.path, data)
	}
	return false, nil
}

func (b testFileBackend) Get(host string) (string, error) {
	data, err := readTestStore(b.path)
	if err != nil {
		return "", err
	}
	return data[host], nil
}

func (b testFileBackend) Set(host, token string) error {
	data, err := readTestStore(b.path)
	if err != nil {
		return err
	}
	data[host] = token
	return writeTestStore(b.path, data)
}

func executableExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func isCredentialMissingText(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "could not be found") ||
		strings.Contains(lower, "not found") ||
		strings.Contains(lower, "item not found") ||
		strings.Contains(lower, "cannot find")
}

func commandOutputText(err error) string {
	if err == nil {
		return ""
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return strings.TrimSpace(string(exitErr.Stderr) + "\n" + err.Error())
	}
	return err.Error()
}

func isMissingCredentialError(err error) bool {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 44 {
		return true
	}
	return isCredentialMissingText(commandOutputText(err))
}

type macOSCredentialBackend struct{}

func macOSSecurityQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (macOSCredentialBackend) Delete(host string) (bool, error) {
	cmd := exec.Command("security", "delete-generic-password", "-s", credentialServiceName, "-a", host)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true, nil
	}
	if isMissingCredentialError(fmt.Errorf("%s\n%s", err, out)) {
		return false, nil
	}
	return false, fmt.Errorf("Failed to delete token from macOS Keychain: %s", strings.TrimSpace(string(out)))
}

func (macOSCredentialBackend) Get(host string) (string, error) {
	cmd := exec.Command("security", "find-generic-password", "-s", credentialServiceName, "-a", host, "-w")
	out, err := cmd.Output()
	if err == nil {
		return strings.TrimSpace(string(out)), nil
	}
	if isMissingCredentialError(err) {
		return "", nil
	}
	return "", fmt.Errorf("Failed to read token from macOS Keychain: %s", commandOutputText(err))
}

func (macOSCredentialBackend) Set(host, token string) error {
	input := fmt.Sprintf(
		"add-generic-password -U -s %s -a %s -w %s\n",
		macOSSecurityQuote(credentialServiceName),
		macOSSecurityQuote(host),
		macOSSecurityQuote(token),
	)
	cmd := exec.Command("security", "-q", "-i")
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("Failed to save token to macOS Keychain: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type linuxCredentialBackend struct{}

func (linuxCredentialBackend) Delete(host string) (bool, error) {
	cmd := exec.Command("secret-tool", "clear", "service", credentialServiceName, "host", host)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true, nil
	}
	if isMissingCredentialError(fmt.Errorf("%s\n%s", err, out)) {
		return false, nil
	}
	return false, fmt.Errorf("Failed to delete token from Secret Service: %s", strings.TrimSpace(string(out)))
}

func (linuxCredentialBackend) Get(host string) (string, error) {
	cmd := exec.Command("secret-tool", "lookup", "service", credentialServiceName, "host", host)
	out, err := cmd.Output()
	if err == nil {
		return strings.TrimSpace(string(out)), nil
	}
	if isMissingCredentialError(err) {
		return "", nil
	}
	return "", fmt.Errorf("Failed to read token from Secret Service: %s", commandOutputText(err))
}

func (linuxCredentialBackend) Set(host, token string) error {
	cmd := exec.Command("secret-tool", "store", "--label=Smithers CLI token", "service", credentialServiceName, "host", host)
	cmd.Stdin = strings.NewReader(token)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("Failed to save token to Secret Service: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type windowsCredentialBackend struct {
	shell string
}

func (b windowsCredentialBackend) run(script string, env map[string]string) (string, error) {
	common := "[Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType=WindowsRuntime] > $null; $vault = New-Object Windows.Security.Credentials.PasswordVault"
	cmd := exec.Command(b.shell, "-NoProfile", "-NonInteractive", "-Command", common+"; "+script)
	cmd.Env = os.Environ()
	cmd.Env = append(cmd.Env, "SMITHERS_CRED_SERVICE="+credentialServiceName)
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (b windowsCredentialBackend) Delete(host string) (bool, error) {
	_, err := b.run("$cred = $vault.Retrieve($env:SMITHERS_CRED_SERVICE, $env:SMITHERS_CRED_HOST); $vault.Remove($cred)", map[string]string{
		"SMITHERS_CRED_HOST": host,
	})
	if err == nil {
		return true, nil
	}
	if isMissingCredentialError(err) {
		return false, nil
	}
	return false, fmt.Errorf("Failed to delete token from Windows Credential Locker: %s", commandOutputText(err))
}

func (b windowsCredentialBackend) Get(host string) (string, error) {
	out, err := b.run("$cred = $vault.Retrieve($env:SMITHERS_CRED_SERVICE, $env:SMITHERS_CRED_HOST); $cred.RetrievePassword(); [Console]::Out.Write($cred.Password)", map[string]string{
		"SMITHERS_CRED_HOST": host,
	})
	if err == nil {
		return strings.TrimSpace(out), nil
	}
	if isMissingCredentialError(err) {
		return "", nil
	}
	return "", fmt.Errorf("Failed to read token from Windows Credential Locker: %s", commandOutputText(err))
}

func (b windowsCredentialBackend) Set(host, token string) error {
	_, err := b.run(`try { $existing = $vault.Retrieve($env:SMITHERS_CRED_SERVICE, $env:SMITHERS_CRED_HOST); $vault.Remove($existing) } catch {}; $cred = New-Object Windows.Security.Credentials.PasswordCredential($env:SMITHERS_CRED_SERVICE, $env:SMITHERS_CRED_HOST, $env:SMITHERS_CRED_TOKEN); $vault.Add($cred)`, map[string]string{
		"SMITHERS_CRED_HOST":  host,
		"SMITHERS_CRED_TOKEN": token,
	})
	if err != nil {
		return fmt.Errorf("Failed to save token to Windows Credential Locker: %s", commandOutputText(err))
	}
	return nil
}

func resolveCredentialBackend() credentialStoreBackend {
	if path := strings.TrimSpace(os.Getenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE")); path != "" {
		return testFileBackend{path: path}
	}
	if os.Getenv("SMITHERS_DISABLE_SYSTEM_KEYRING") == "1" {
		return nil
	}
	switch cliGOOS {
	case "darwin":
		if executableExists("security") {
			return macOSCredentialBackend{}
		}
	case "linux":
		if executableExists("secret-tool") {
			return linuxCredentialBackend{}
		}
	case "windows":
		if shell, err := exec.LookPath("pwsh"); err == nil {
			return windowsCredentialBackend{shell: shell}
		}
		if shell, err := exec.LookPath("powershell"); err == nil {
			return windowsCredentialBackend{shell: shell}
		}
	}
	return nil
}

func LoadStoredToken(host string) string {
	normalized, err := normalizeCredentialHost(host)
	if err != nil {
		return ""
	}
	backend := resolveCredentialBackend()
	if backend == nil {
		return ""
	}
	token, err := backend.Get(normalized)
	if err != nil {
		return ""
	}
	return token
}

func StoreToken(host, token string) error {
	normalized, err := normalizeCredentialHost(host)
	if err != nil {
		return err
	}
	backend := resolveCredentialBackend()
	if backend == nil {
		return &SecureStorageUnavailableError{
			Message: "Secure credential storage is unavailable. Use SMITHERS_TOKEN for headless or CI workflows.",
		}
	}
	return backend.Set(normalized, strings.TrimSpace(token))
}

func DeleteStoredToken(host string) bool {
	normalized, err := normalizeCredentialHost(host)
	if err != nil {
		return false
	}
	backend := resolveCredentialBackend()
	if backend == nil {
		return false
	}
	deleted, err := backend.Delete(normalized)
	return err == nil && deleted
}
