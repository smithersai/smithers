package smitherscli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// credFWriteFakeBin creates an executable script named `name` in dir whose
// behavior is switched by the FAKE_CRED_MODE env var at exec time.
func credFWriteFakeBin(t *testing.T, dir, name string) {
	t.Helper()
	script := `#!/bin/sh
case "$FAKE_CRED_MODE" in
  success) echo "the-token"; exit 0;;
  missing) echo "could not be found" 1>&2; exit 44;;
  *) echo "boom failure" 1>&2; exit 1;;
esac
`
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestCredentials_F_MacOSBackend(t *testing.T) {
	binDir := t.TempDir()
	credFWriteFakeBin(t, binDir, "security")
	t.Setenv("PATH", binDir)
	b := macOSCredentialBackend{}

	t.Setenv("FAKE_CRED_MODE", "success")
	if ok, err := b.Delete("h"); err != nil || !ok {
		t.Fatalf("Delete success = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "the-token" {
		t.Fatalf("Get success = %q, %v", tok, err)
	}
	if err := b.Set("h", "tok"); err != nil {
		t.Fatalf("Set success = %v", err)
	}

	t.Setenv("FAKE_CRED_MODE", "missing")
	if ok, err := b.Delete("h"); err != nil || ok {
		t.Fatalf("Delete missing = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "" {
		t.Fatalf("Get missing = %q, %v", tok, err)
	}

	t.Setenv("FAKE_CRED_MODE", "error")
	if _, err := b.Delete("h"); err == nil {
		t.Fatal("Delete error expected")
	}
	if _, err := b.Get("h"); err == nil {
		t.Fatal("Get error expected")
	}
	if err := b.Set("h", "tok"); err == nil {
		t.Fatal("Set error expected")
	}
}

func TestCredentials_F_MacOSBackendSetKeepsTokenOffArgv(t *testing.T) {
	binDir := t.TempDir()
	argsPath := filepath.Join(t.TempDir(), "args.txt")
	stdinPath := filepath.Join(t.TempDir(), "stdin.txt")
	script := `#!/bin/sh
printf '%s\n' "$*" > "$FAKE_CRED_ARGS_FILE"
while IFS= read -r line; do
  printf '%s\n' "$line"
done > "$FAKE_CRED_STDIN_FILE"
exit 0
`
	securityPath := filepath.Join(binDir, "security")
	if err := os.WriteFile(securityPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("FAKE_CRED_ARGS_FILE", argsPath)
	t.Setenv("FAKE_CRED_STDIN_FILE", stdinPath)

	token := "smithers_secret-token"
	if err := (macOSCredentialBackend{}).Set("api.example.com", token); err != nil {
		t.Fatalf("Set returned error: %v", err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := os.ReadFile(stdinPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(args), token) {
		t.Fatalf("security argv leaked token: %q", string(args))
	}
	if !strings.Contains(string(stdin), token) {
		t.Fatalf("security stdin did not receive token: %q", string(stdin))
	}
	if !strings.Contains(string(args), "-i") {
		t.Fatalf("security was not invoked in interactive mode: %q", string(args))
	}
}

func TestCredentials_F_LinuxBackend(t *testing.T) {
	binDir := t.TempDir()
	credFWriteFakeBin(t, binDir, "secret-tool")
	t.Setenv("PATH", binDir)
	b := linuxCredentialBackend{}

	t.Setenv("FAKE_CRED_MODE", "success")
	if ok, err := b.Delete("h"); err != nil || !ok {
		t.Fatalf("Delete success = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "the-token" {
		t.Fatalf("Get success = %q, %v", tok, err)
	}
	if err := b.Set("h", "tok"); err != nil {
		t.Fatalf("Set success = %v", err)
	}

	t.Setenv("FAKE_CRED_MODE", "missing")
	if ok, err := b.Delete("h"); err != nil || ok {
		t.Fatalf("Delete missing = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "" {
		t.Fatalf("Get missing = %q, %v", tok, err)
	}

	t.Setenv("FAKE_CRED_MODE", "error")
	if _, err := b.Delete("h"); err == nil {
		t.Fatal("Delete error expected")
	}
	if _, err := b.Get("h"); err == nil {
		t.Fatal("Get error expected")
	}
	if err := b.Set("h", "tok"); err == nil {
		t.Fatal("Set error expected")
	}
}

func TestCredentials_F_WindowsBackend(t *testing.T) {
	binDir := t.TempDir()
	// The windows backend passes -NoProfile -NonInteractive -Command <script>
	// as args; our fake ignores them and switches on FAKE_CRED_MODE.
	credFWriteFakeBin(t, binDir, "fakeshell")
	shell := filepath.Join(binDir, "fakeshell")
	b := windowsCredentialBackend{shell: shell}

	t.Setenv("FAKE_CRED_MODE", "success")
	if ok, err := b.Delete("h"); err != nil || !ok {
		t.Fatalf("Delete success = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "the-token" {
		t.Fatalf("Get success = %q, %v", tok, err)
	}
	if err := b.Set("h", "tok"); err != nil {
		t.Fatalf("Set success = %v", err)
	}

	t.Setenv("FAKE_CRED_MODE", "missing")
	if ok, err := b.Delete("h"); err != nil || ok {
		t.Fatalf("Delete missing = %v, %v", ok, err)
	}
	if tok, err := b.Get("h"); err != nil || tok != "" {
		t.Fatalf("Get missing = %q, %v", tok, err)
	}

	t.Setenv("FAKE_CRED_MODE", "error")
	if _, err := b.Delete("h"); err == nil {
		t.Fatal("Delete error expected")
	}
	if _, err := b.Get("h"); err == nil {
		t.Fatal("Get error expected")
	}
	if err := b.Set("h", "tok"); err == nil {
		t.Fatal("Set error expected")
	}
}

func TestCredentials_F_ResolveBackendPerOS(t *testing.T) {
	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", "")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "")

	oldGOOS := cliGOOS
	t.Cleanup(func() { cliGOOS = oldGOOS })

	// darwin with security present
	binDir := t.TempDir()
	credFWriteFakeBin(t, binDir, "security")
	credFWriteFakeBin(t, binDir, "secret-tool")
	credFWriteFakeBin(t, binDir, "pwsh")
	t.Setenv("PATH", binDir)

	cliGOOS = "darwin"
	if _, ok := resolveCredentialBackend().(macOSCredentialBackend); !ok {
		t.Fatal("darwin should resolve macOS backend")
	}
	cliGOOS = "linux"
	if _, ok := resolveCredentialBackend().(linuxCredentialBackend); !ok {
		t.Fatal("linux should resolve linux backend")
	}
	cliGOOS = "windows"
	if _, ok := resolveCredentialBackend().(windowsCredentialBackend); !ok {
		t.Fatal("windows should resolve windows backend (pwsh)")
	}

	// windows falling back to powershell (no pwsh)
	psDir := t.TempDir()
	credFWriteFakeBin(t, psDir, "powershell")
	t.Setenv("PATH", psDir)
	cliGOOS = "windows"
	if _, ok := resolveCredentialBackend().(windowsCredentialBackend); !ok {
		t.Fatal("windows should resolve windows backend (powershell)")
	}

	// none available -> nil for every OS
	emptyDir := t.TempDir()
	t.Setenv("PATH", emptyDir)
	cliGOOS = "darwin"
	if b := resolveCredentialBackend(); b != nil {
		t.Fatalf("darwin no security = %#v", b)
	}
	cliGOOS = "linux"
	if b := resolveCredentialBackend(); b != nil {
		t.Fatalf("linux no secret-tool = %#v", b)
	}
	cliGOOS = "windows"
	if b := resolveCredentialBackend(); b != nil {
		t.Fatalf("windows no shell = %#v", b)
	}
	cliGOOS = "plan9"
	if b := resolveCredentialBackend(); b != nil {
		t.Fatalf("unknown OS = %#v", b)
	}
}

func TestCredentials_F_TestStoreEdgeCases(t *testing.T) {
	dir := t.TempDir()

	// read error: path is a directory (not IsNotExist)
	if _, err := readTestStore(dir); err == nil {
		t.Fatal("readTestStore on directory should error")
	}

	// empty file -> empty map, no error
	emptyPath := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(emptyPath, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if data, err := readTestStore(emptyPath); err != nil || len(data) != 0 {
		t.Fatalf("readTestStore empty = %#v, %v", data, err)
	}

	// writeTestStore mkdir error: parent path is a file
	filePath := filepath.Join(dir, "afile")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeTestStore(filepath.Join(filePath, "child", "store.json"), map[string]string{}); err == nil {
		t.Fatal("writeTestStore into file parent should error")
	}

	// writeTestStore marshal error via seam
	oldMarshal := credMarshalIndent
	credMarshalIndent = func(any, string, string) ([]byte, error) { return nil, errors.New("marshal boom") }
	t.Cleanup(func() { credMarshalIndent = oldMarshal })
	if err := writeTestStore(filepath.Join(dir, "ok.json"), map[string]string{}); err == nil {
		t.Fatal("writeTestStore marshal error expected")
	}
	credMarshalIndent = oldMarshal

	// testFileBackend.Delete read error (store path is a directory)
	backend := testFileBackend{path: dir}
	if _, err := backend.Delete("h"); err == nil {
		t.Fatal("testFileBackend.Delete on directory should error")
	}
}
