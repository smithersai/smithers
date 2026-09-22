package flowmanifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bundledManifest(t *testing.T) (string, map[string]rawHost) {
	t.Helper()
	directory := t.TempDir()
	hosts := map[string]rawHost{}
	for family, flows := range expectedFlows {
		name := "smithers-" + family + "-host-v10"
		contents := []byte("host:" + family)
		if err := os.WriteFile(filepath.Join(directory, name), contents, 0o755); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(contents)
		hosts[family] = rawHost{Executable: name, SHA256: hex.EncodeToString(digest[:]), Flows: flows}
	}
	return filepath.Join(directory, "flow-hosts.json"), hosts
}

func writeManifest(t *testing.T, path string, hosts map[string]rawHost) {
	t.Helper()
	data, err := json.Marshal(rawManifest{Version: 1, Hosts: hosts})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadVerifiesTwoCanonicalHosts(t *testing.T) {
	path, hosts := bundledManifest(t)
	writeManifest(t, path, hosts)
	registry, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Coding.Executable != filepath.Join(filepath.Dir(path), hosts["coding"].Executable) ||
		registry.Librarian.SHA256 != hosts["librarian"].SHA256 {
		t.Fatalf("wrong registry: %+v", registry)
	}
	if err := os.WriteFile(registry.Coding.Executable, []byte("altered host"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered host accepted: %v", err)
	}
}

func TestLoadRejectsEscapedOrSubstitutedHost(t *testing.T) {
	path, hosts := bundledManifest(t)
	coding := hosts["coding"]
	coding.Executable = "../other-host"
	hosts["coding"] = coding
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "basename") {
		t.Fatalf("path escape accepted: %v", err)
	}
	coding.Executable = "smithers-coding-host-v10"
	hosts["coding"] = coding
	if err := os.Remove(filepath.Join(filepath.Dir(path), coding.Executable)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(path), hosts["librarian"].Executable), filepath.Join(filepath.Dir(path), coding.Executable)); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("symlinked host accepted: %v", err)
	}
}

func TestLoadRejectsMissingFlow(t *testing.T) {
	path, hosts := bundledManifest(t)
	librarian := hosts["librarian"]
	librarian.Flows = []string{"librarian/wiki"}
	hosts["librarian"] = librarian
	writeManifest(t, path, hosts)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "unexpected flows") {
		t.Fatalf("incomplete flow host accepted: %v", err)
	}
}
