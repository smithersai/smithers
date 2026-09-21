package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	gossh "golang.org/x/crypto/ssh"
)

func TestWorkspaceSSHHostkey_Cov_EmptyDirAndInvalidFiles(t *testing.T) {
	if _, err := NewDiskHostKeyLoader("").LoadHostKeys(); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty dir err = %v", err)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, primaryHostKeyFile), []byte("not a key"), 0o644); err != nil {
		t.Fatalf("write key: %v", err)
	}
	_, err := NewDiskHostKeyLoader(dir).LoadHostKeys()
	if err == nil || !strings.Contains(err.Error(), "parse") {
		t.Fatalf("invalid key err = %v", err)
	}
}

func TestWorkspaceSSHHostkey_Cov_ParsePublicHostKeySkipsCommentsAndHosts(t *testing.T) {
	dir := t.TempDir()
	signer := writeEd25519HostKey(t, filepath.Join(dir, "key"))
	line := "host.example.test " + strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey()))) + " comment"
	pub, err := parsePublicHostKey([]byte("# comment\n\nignored\n" + line + "\n"))
	if err != nil {
		t.Fatalf("parsePublicHostKey returned error: %v", err)
	}
	if gossh.FingerprintSHA256(pub) != gossh.FingerprintSHA256(signer.PublicKey()) {
		t.Fatalf("fingerprint mismatch")
	}

	if _, err := parsePublicHostKey([]byte("# only comments\nnot enough\n")); err == nil {
		t.Fatal("expected no parseable public key error")
	}
}

func TestWorkspaceSSHHostkey_Cov_ReadPublicKeyFile(t *testing.T) {
	dir := t.TempDir()
	signer := writeEd25519HostKey(t, filepath.Join(dir, "source"))
	publicLine := strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey())))
	path := filepath.Join(dir, "pub")
	if err := os.WriteFile(path, []byte(publicLine+"\n"), 0o644); err != nil {
		t.Fatalf("write public key: %v", err)
	}
	key, err := readHostPublicKey(path)
	if err != nil {
		t.Fatalf("readHostPublicKey returned error: %v", err)
	}
	if key.KnownHostsLine != publicLine || key.FingerprintSHA256 == "" || key.PublicKey == "" {
		t.Fatalf("key = %+v", key)
	}
}
