package webhook

import (
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecretCodec_Cov_NewRejectsBlankSecret(t *testing.T) {
	t.Parallel()

	for _, secret := range []string{"", " \t\n"} {
		secret := secret
		t.Run("blank", func(t *testing.T) {
			t.Parallel()

			codec, err := NewSecretCodec(secret)

			require.EqualError(t, err, "webhook secret encryption key is required")
			assert.Nil(t, codec)
		})
	}
}

func TestSecretCodec_Cov_BadKeyEncryptDecryptErrors(t *testing.T) {
	t.Parallel()

	codec := &AESGCMSecretCodec{key: []byte("short")}

	ciphertext, err := codec.EncryptString("super-secret")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid key size")
	assert.Empty(t, ciphertext)

	encoded := base64.StdEncoding.EncodeToString([]byte("ciphertext"))
	plaintext, err := codec.DecryptString(encoded)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid key size")
	assert.Empty(t, plaintext)
}

func TestSecretCodec_Cov_NoopEncryptReturnsPlaintext(t *testing.T) {
	t.Parallel()

	codec := NoopSecretCodec{}

	ciphertext, err := codec.EncryptString("plain-secret")

	require.NoError(t, err)
	assert.Equal(t, "plain-secret", ciphertext)
}
