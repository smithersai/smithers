package webhook

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecretCodec_EncryptDecrypt_RoundTrip(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("unit-test-webhook-key")
	require.NoError(t, err)

	ciphertext, err := codec.EncryptString("super-secret")
	require.NoError(t, err)
	assert.NotEmpty(t, ciphertext)
	assert.NotEqual(t, "super-secret", ciphertext)

	plaintext, err := codec.DecryptString(ciphertext)
	require.NoError(t, err)
	assert.Equal(t, "super-secret", plaintext)
}

func TestSecretCodec_Encrypt_EmptyPlaintextReturnsEmpty(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("unit-test-webhook-key")
	require.NoError(t, err)

	ciphertext, err := codec.EncryptString("")
	require.NoError(t, err)
	assert.Equal(t, "", ciphertext)
}

func TestSecretCodec_Decrypt_EmptyCiphertextReturnsEmpty(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("unit-test-webhook-key")
	require.NoError(t, err)

	plaintext, err := codec.DecryptString("")
	require.NoError(t, err)
	assert.Equal(t, "", plaintext)
}

func TestSecretCodec_Decrypt_InvalidCiphertextFails(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("unit-test-webhook-key")
	require.NoError(t, err)

	_, err = codec.DecryptString("not-base64@@")
	require.Error(t, err)
}
