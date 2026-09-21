package crypto

import (
	cryptorand "crypto/rand"
	"errors"
	"strings"
	"testing"
)

var cryptoCovNonceErr = errors.New("forced nonce failure")

type cryptoCovFailingReader struct{}

func (cryptoCovFailingReader) Read([]byte) (int, error) {
	return 0, cryptoCovNonceErr
}

func TestCrypto_Cov_EncryptInvalidKey(t *testing.T) {
	ciphertext, err := Encrypt([]byte("short"), []byte("plaintext"))
	if err == nil {
		t.Fatal("expected invalid key error")
	}
	if ciphertext != nil {
		t.Fatalf("expected nil ciphertext, got %x", ciphertext)
	}
	if !strings.Contains(err.Error(), "failed to create cipher: crypto/aes: invalid key size 5") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCrypto_Cov_EncryptNonceFailure(t *testing.T) {
	originalReader := cryptorand.Reader
	cryptorand.Reader = cryptoCovFailingReader{}
	defer func() {
		cryptorand.Reader = originalReader
	}()

	ciphertext, err := Encrypt(DeriveKey("nonce-failure"), []byte("plaintext"))
	if err == nil {
		t.Fatal("expected nonce generation error")
	}
	if ciphertext != nil {
		t.Fatalf("expected nil ciphertext, got %x", ciphertext)
	}
	if !errors.Is(err, cryptoCovNonceErr) {
		t.Fatalf("expected wrapped nonce error, got %v", err)
	}
	if !strings.Contains(err.Error(), "failed to generate nonce") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestCrypto_Cov_DecryptInvalidKey(t *testing.T) {
	plaintext, err := Decrypt([]byte("short"), []byte("ciphertext"))
	if err == nil {
		t.Fatal("expected invalid key error")
	}
	if plaintext != nil {
		t.Fatalf("expected nil plaintext, got %q", plaintext)
	}
	if !strings.Contains(err.Error(), "failed to create cipher: crypto/aes: invalid key size 5") {
		t.Fatalf("unexpected error: %v", err)
	}
}
