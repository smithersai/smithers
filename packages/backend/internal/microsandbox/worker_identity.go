package microsandbox

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LoadOrCreateWorkerIdentity returns the per-node signing key used to bind a
// durable worker ID to its heartbeats. The key lives on the worker hostPath so
// a pod rollout keeps the same identity. Creation uses link(2) as an atomic
// no-replace publish operation, avoiding two overlapping pods choosing
// different identities for the same node.
func LoadOrCreateWorkerIdentity(path string) (ed25519.PrivateKey, error) {
	if key, err := readWorkerIdentity(path); err == nil {
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create worker identity directory: %w", err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate worker identity: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".worker-identity-*")
	if err != nil {
		return nil, fmt.Errorf("create worker identity temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return nil, err
	}
	if _, err := temporary.Write(privateKey); err != nil {
		_ = temporary.Close()
		return nil, fmt.Errorf("write worker identity: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return nil, fmt.Errorf("sync worker identity: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return nil, fmt.Errorf("close worker identity: %w", err)
	}
	if err := os.Link(temporaryPath, path); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("publish worker identity: %w", err)
		}
		return readWorkerIdentity(path)
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return nil, fmt.Errorf("open worker identity directory: %w", err)
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil || closeErr != nil {
		return nil, errors.Join(syncErr, closeErr)
	}
	return privateKey, nil
}

func readWorkerIdentity(path string) (ed25519.PrivateKey, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(payload) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("worker identity key has invalid size %d", len(payload))
	}
	return ed25519.PrivateKey(append([]byte(nil), payload...)), nil
}
