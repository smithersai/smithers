package services

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	gossh "golang.org/x/crypto/ssh"
)

// primaryHostKeyFile and nextHostKeyFile are the on-disk filenames the
// gateway SSH server uses (primary) and the operational runbook reserves
// for a pending rotation (next). See docs/operations/ssh-host-key-rotation.md.
const (
	primaryHostKeyFile = "ssh_host_ed25519_key"
	nextHostKeyFile    = "ssh_host_ed25519_key.next"
)

// HostKeyLoader returns the current set of SSH gateway host keys that
// clients should accept. It returns keys in priority order: the
// currently-active key first, optional rotation candidates next.
//
// Implementations must NOT return private-key material. The caller
// publishes only the public half over the authenticated API.
type HostKeyLoader interface {
	LoadHostKeys() ([]WorkspaceSSHHostKey, error)
}

// diskHostKeyLoader reads gateway host keys from disk. It pairs with the
// layout the SSH server uses (internal/ssh/server.go) so the gateway and
// the trust anchor advertised to clients stay in sync.
type diskHostKeyLoader struct {
	dir string
}

// NewDiskHostKeyLoader returns a HostKeyLoader that reads the gateway's
// host-key files from dir. It reads primaryHostKeyFile (required) and,
// if present, nextHostKeyFile (optional, for overlap during rotation).
//
// An absent primary key is an error: without it we cannot verify
// anything and must fail closed rather than silently re-enabling the
// previous insecure-ignore behavior.
func NewDiskHostKeyLoader(dir string) HostKeyLoader {
	return &diskHostKeyLoader{dir: dir}
}

// LoadHostKeys implements HostKeyLoader.
func (l *diskHostKeyLoader) LoadHostKeys() ([]WorkspaceSSHHostKey, error) {
	if l.dir == "" {
		return nil, errors.New("host key dir is empty")
	}

	primary, err := readHostPublicKey(filepath.Join(l.dir, primaryHostKeyFile))
	if err != nil {
		return nil, fmt.Errorf("load primary host key: %w", err)
	}
	keys := []WorkspaceSSHHostKey{primary}

	next, err := readHostPublicKey(filepath.Join(l.dir, nextHostKeyFile))
	switch {
	case err == nil:
		// Skip if the next key is byte-identical to the primary; a stale
		// rotation file should never silently duplicate the trust set.
		if next.PublicKey != primary.PublicKey {
			keys = append(keys, next)
		}
	case errors.Is(err, fs.ErrNotExist):
		// No rotation in progress — fine.
	default:
		return nil, fmt.Errorf("load next host key: %w", err)
	}

	return keys, nil
}

// readHostPublicKey reads either an OpenSSH private host-key file or a
// public known_hosts/authorized_keys line and returns the public half
// formatted for the API. It never returns private material.
func readHostPublicKey(path string) (WorkspaceSSHHostKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return WorkspaceSSHHostKey{}, err
	}
	signer, err := gossh.ParsePrivateKey(raw)
	if err == nil {
		return publicKeyToWorkspaceHostKey(signer.PublicKey()), nil
	}

	pub, parseErr := parsePublicHostKey(raw)
	if parseErr != nil {
		return WorkspaceSSHHostKey{}, fmt.Errorf("parse %s: private key: %v; public key: %w", filepath.Base(path), err, parseErr)
	}
	return publicKeyToWorkspaceHostKey(pub), nil
}

func parsePublicHostKey(raw []byte) (gossh.PublicKey, error) {
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		candidate := line
		if !strings.HasPrefix(fields[0], "ssh-") && len(fields) >= 3 && strings.HasPrefix(fields[1], "ssh-") {
			candidate = strings.Join(fields[1:], " ")
		}
		pub, _, _, _, err := gossh.ParseAuthorizedKey([]byte(candidate))
		if err == nil {
			return pub, nil
		}
	}
	return nil, errors.New("no parseable public SSH host key")
}

// publicKeyToWorkspaceHostKey projects an SSH public key onto the wire
// shape the API publishes. It is a pure function: same input -> same
// output, with no I/O. The test suite uses this directly against keys
// generated in-process.
func publicKeyToWorkspaceHostKey(pub gossh.PublicKey) WorkspaceSSHHostKey {
	marshaled := pub.Marshal()
	return WorkspaceSSHHostKey{
		Algorithm:         pub.Type(),
		PublicKey:         base64.StdEncoding.EncodeToString(marshaled),
		FingerprintSHA256: gossh.FingerprintSHA256(pub),
		KnownHostsLine:    strings.TrimRight(string(gossh.MarshalAuthorizedKey(pub)), "\n"),
	}
}
