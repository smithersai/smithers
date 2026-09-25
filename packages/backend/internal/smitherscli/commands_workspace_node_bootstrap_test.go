package smitherscli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runNodeBootstrapInSandbox executes buildWorkspaceNodeBootstrapScript under a
// real bash with /home/developer rewritten to a temp home. PATH holds only a
// shim directory: `install` drops the -o/-g ownership flags, core file tools
// link to the host binaries, and node/npm exist only when requested.
func runNodeBootstrapInSandbox(t *testing.T, tools ...string) (string, string, error) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not available")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	shims := filepath.Join(root, "shims")
	if err := os.MkdirAll(shims, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"rm", "mkdir", "ln"} {
		real, err := exec.LookPath(name)
		if err != nil {
			t.Skipf("%s is not available", name)
		}
		if err := os.Symlink(real, filepath.Join(shims, name)); err != nil {
			t.Fatal(err)
		}
	}
	mkdir, _ := exec.LookPath("mkdir")
	writeShim := func(name, body string) {
		if err := os.WriteFile(filepath.Join(shims, name), []byte("#!"+bash+"\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeShim("install", `exec `+mkdir+` -p "${@: -1}"`)
	for _, name := range tools {
		writeShim(name, "exit 0")
	}

	script := strings.ReplaceAll(buildWorkspaceNodeBootstrapScript(), "/home/developer", home)
	cmd := exec.Command(bash, "-c", "set -euo pipefail\n"+script)
	cmd.Env = []string{"PATH=" + shims, "HOME=" + home}
	out, err := cmd.CombinedOutput()
	return home, string(out), err
}

func TestWorkspaceNodeBootstrap_UsesImageNodeWithoutDanglingLinks(t *testing.T) {
	var home string
	for run := 1; run <= 2; run++ {
		var out string
		var err error
		home, out, err = runNodeBootstrapInSandbox(t, "node", "npm")
		if err != nil {
			t.Fatalf("run %d: node bootstrap failed with node and npm on PATH: %v\n%s", run, err, out)
		}
	}
	if _, err := os.Lstat(filepath.Join(home, ".local", "node")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("node bootstrap created an unused ~/.local/node directory (err=%v)", err)
	}
	binDir := filepath.Join(home, ".local", "bin")
	entries, err := os.ReadDir(binDir)
	if err != nil {
		t.Fatalf("node bootstrap did not create %s: %v", binDir, err)
	}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(binDir, entry.Name())); err != nil {
			t.Fatalf("node bootstrap left dangling %s: %v", filepath.Join(binDir, entry.Name()), err)
		}
	}
}

func TestWorkspaceNodeBootstrap_FailsWhenNpmIsMissing(t *testing.T) {
	_, out, err := runNodeBootstrapInSandbox(t, "node")
	if err == nil {
		t.Fatalf("node bootstrap succeeded without npm on PATH; the claude install would fail later\n%s", out)
	}
	if !strings.Contains(out, "npm") {
		t.Fatalf("node bootstrap error does not name npm: %q", out)
	}
}

func TestClaudeDiagnostics_DoesNotTailUnwrittenNodeInstallLog(t *testing.T) {
	diagnostics := buildClaudeDiagnosticsRemoteScript()
	for _, stale := range []string{"node-install.log", "node_install_log", "/home/developer/.local/node"} {
		if strings.Contains(diagnostics, stale) {
			t.Fatalf("diagnostics script references %q, which nothing in the workspace writes:\n%s", stale, diagnostics)
		}
	}
}
