package crypto

import (
	"bytes"
	"testing"
)

func TestDeriveKey(t *testing.T) {
	tests := []struct {
		name   string
		secret string
	}{
		{"empty string", ""},
		{"short secret", "short"},
		{"long secret", "this is a much longer secret string that exceeds 32 bytes"},
		{"unicode secret", "日本語の秘密鍵"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			key := DeriveKey(tc.secret)
			if len(key) != 32 {
				t.Errorf("expected key length 32, got %d", len(key))
			}
		})
	}

	// Verify deterministic derivation
	key1 := DeriveKey("same-secret")
	key2 := DeriveKey("same-secret")
	if !bytes.Equal(key1, key2) {
		t.Error("key derivation should be deterministic")
	}

	// Verify different secrets produce different keys
	key3 := DeriveKey("different-secret")
	if bytes.Equal(key1, key3) {
		t.Error("different secrets should produce different keys")
	}
}

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	key := DeriveKey("test-encryption-key-for-unit-tests")

	tests := []struct {
		name      string
		plaintext []byte
	}{
		{"simple text", []byte("hello world")},
		{"long text", []byte("this is a longer text that exceeds multiple blocks for aes gcm encryption")},
		{"binary data", []byte{0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd}},
		{"unicode text", []byte("Hello, 世界! 🌍")},
		{"single byte", []byte("x")},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ciphertext, err := Encrypt(key, tc.plaintext)
			if err != nil {
				t.Fatalf("encrypt failed: %v", err)
			}

			// Ciphertext should be different from plaintext
			if bytes.Equal(ciphertext, tc.plaintext) {
				t.Error("ciphertext should not equal plaintext")
			}

			// Ciphertext should include nonce (12 bytes) + ciphertext + tag (16 bytes)
			if len(ciphertext) < 28 {
				t.Errorf("ciphertext too short: %d bytes", len(ciphertext))
			}

			decrypted, err := Decrypt(key, ciphertext)
			if err != nil {
				t.Fatalf("decrypt failed: %v", err)
			}

			if !bytes.Equal(decrypted, tc.plaintext) {
				t.Errorf("decrypted text doesn't match original: got %q, want %q", decrypted, tc.plaintext)
			}
		})
	}
}

func TestEncrypt_EmptyPlaintext(t *testing.T) {
	key := DeriveKey("test-key")
	_, err := Encrypt(key, []byte{})
	if err == nil {
		t.Error("expected error for empty plaintext")
	}
}

func TestDecrypt_EmptyCiphertext(t *testing.T) {
	key := DeriveKey("test-key")
	_, err := Decrypt(key, []byte{})
	if err == nil {
		t.Error("expected error for empty ciphertext")
	}
}

func TestDecrypt_ShortCiphertext(t *testing.T) {
	key := DeriveKey("test-key")
	// 11 bytes is less than nonce size (12)
	_, err := Decrypt(key, []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10})
	if err == nil {
		t.Error("expected error for ciphertext shorter than nonce")
	}
}

func TestDecrypt_WrongKey(t *testing.T) {
	key1 := DeriveKey("correct-key")
	key2 := DeriveKey("wrong-key")

	plaintext := []byte("secret message")
	ciphertext, err := Encrypt(key1, plaintext)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}

	_, err = Decrypt(key2, ciphertext)
	if err == nil {
		t.Error("expected error when decrypting with wrong key")
	}
}

func TestDecrypt_TamperedCiphertext(t *testing.T) {
	key := DeriveKey("test-key")

	plaintext := []byte("secret message")
	ciphertext, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}

	// Tamper with the ciphertext (after nonce, before tag)
	tampered := make([]byte, len(ciphertext))
	copy(tampered, ciphertext)
	tampered[15] ^= 0xff // Flip some bits

	_, err = Decrypt(key, tampered)
	if err == nil {
		t.Error("expected error when decrypting tampered ciphertext")
	}
}

func TestEncrypt_DifferentNonces(t *testing.T) {
	key := DeriveKey("test-key")
	plaintext := []byte("same plaintext")

	ciphertext1, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("first encrypt failed: %v", err)
	}

	ciphertext2, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("second encrypt failed: %v", err)
	}

	// Same plaintext encrypted twice should produce different ciphertexts
	// due to random nonces
	if bytes.Equal(ciphertext1, ciphertext2) {
		t.Error("same plaintext should produce different ciphertexts due to random nonce")
	}

	// But both should decrypt to the same plaintext
	decrypted1, err := Decrypt(key, ciphertext1)
	if err != nil {
		t.Fatalf("first decrypt failed: %v", err)
	}

	decrypted2, err := Decrypt(key, ciphertext2)
	if err != nil {
		t.Fatalf("second decrypt failed: %v", err)
	}

	if !bytes.Equal(decrypted1, plaintext) || !bytes.Equal(decrypted2, plaintext) {
		t.Error("decrypted texts should match original plaintext")
	}
}

func TestEncryptDecrypt_LargeData(t *testing.T) {
	key := DeriveKey("test-key")

	// 1MB of data
	plaintext := make([]byte, 1024*1024)
	for i := range plaintext {
		plaintext[i] = byte(i % 256)
	}

	ciphertext, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}

	decrypted, err := Decrypt(key, ciphertext)
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Error("decrypted data doesn't match original")
	}
}
