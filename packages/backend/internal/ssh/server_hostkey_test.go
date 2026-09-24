package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

func TestEnsureHostKey_CreatesEd25519KeyWithoutSshKeygen(t *testing.T) {
	t.Parallel()

	hostKeyPath := filepath.Join(t.TempDir(), "ssh_host_ed25519_key")
	_, err := os.Stat(hostKeyPath)
	require.Error(t, err)

	signer, err := ensureHostKey(hostKeyPath)
	require.NoError(t, err)
	require.NotNil(t, signer)

	keyBytes, err := os.ReadFile(hostKeyPath)
	require.NoError(t, err)
	parsedSigner, err := gossh.ParsePrivateKey(keyBytes)
	require.NoError(t, err)
	require.NotNil(t, parsedSigner)
	assert.Equal(t, signer.PublicKey().Marshal(), parsedSigner.PublicKey().Marshal())
}

func TestEnsureHostKey_UsesExistingKey(t *testing.T) {
	t.Parallel()

	hostKeyPath := filepath.Join(t.TempDir(), "ssh_host_ed25519_key")
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	der, err := x509.MarshalPKCS8PrivateKey(priv)
	require.NoError(t, err)
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	})
	require.NoError(t, os.WriteFile(hostKeyPath, pemBytes, 0600))

	signer, err := ensureHostKey(hostKeyPath)
	require.NoError(t, err)
	require.NotNil(t, signer)

	expectedPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)
	assert.Equal(t, expectedPub.Marshal(), signer.PublicKey().Marshal())
}
