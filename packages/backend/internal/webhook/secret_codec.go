package webhook

import (
	"encoding/base64"
	"fmt"
	"strings"

	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
)

// SecretCodec encodes webhook signing secrets for storage and use.
type SecretCodec interface {
	EncryptString(plaintext string) (string, error)
	DecryptString(ciphertext string) (string, error)
}

// AESGCMSecretCodec encrypts/decrypts webhook secrets with AES-256-GCM.
type AESGCMSecretCodec struct {
	key []byte
}

// NewSecretCodec builds a codec from the configured server secret.
func NewSecretCodec(secret string) (*AESGCMSecretCodec, error) {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return nil, fmt.Errorf("webhook secret encryption key is required")
	}
	return &AESGCMSecretCodec{key: smitherscrypto.DeriveKey(trimmed)}, nil
}

func (c *AESGCMSecretCodec) EncryptString(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	ciphertext, err := smitherscrypto.Encrypt(c.key, []byte(plaintext))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (c *AESGCMSecretCodec) DecryptString(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}

	cipherBytes, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}

	plaintext, err := smitherscrypto.Decrypt(c.key, cipherBytes)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// NoopSecretCodec leaves strings unchanged (useful in tests).
type NoopSecretCodec struct{}

func (NoopSecretCodec) EncryptString(plaintext string) (string, error) {
	return plaintext, nil
}

func (NoopSecretCodec) DecryptString(ciphertext string) (string, error) {
	return ciphertext, nil
}
