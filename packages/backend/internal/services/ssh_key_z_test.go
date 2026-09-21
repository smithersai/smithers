package services

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSSHKey_Z_CreateValidationAndKeyValidationBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	svc := NewSSHKeyService(mockSSHKeyQuerier{})

	_, err := svc.CreateKey(ctx, 1, CreateSSHKeyRequest{Title: "", Key: "ssh-ed25519 AAAA"})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = svc.CreateKey(ctx, 1, CreateSSHKeyRequest{Title: strings.Repeat("a", 256), Key: "ssh-ed25519 AAAA"})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = svc.CreateKey(ctx, 1, CreateSSHKeyRequest{Title: "laptop", Key: ""})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	key := mustGenerateEd25519AuthorizedKey(t)
	svc = NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByFingerprintFn: func(context.Context, string) (db.SshKey, error) {
			return db.SshKey{}, pgx.ErrNoRows
		},
	})
	_, err = svc.CreateKey(ctx, 1, CreateSSHKeyRequest{Title: "bad\x00title", Key: key})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	_, _, err = parseAuthorizedKey(" ")
	require.Error(t, err)
	require.Error(t, validatePublicKey(sshKeyZPublicKey{typ: "fake"}))
	require.Error(t, validatePublicKey(sshKeyZCryptoPublicKey{
		sshKeyZPublicKey: sshKeyZPublicKey{typ: "ecdsa-sha2-nistp224"},
		key:              &ecdsa.PublicKey{Curve: elliptic.P224()},
	}))
}

type sshKeyZPublicKey struct {
	typ string
}

func (k sshKeyZPublicKey) Type() string { return k.typ }
func (k sshKeyZPublicKey) Marshal() []byte {
	return []byte("fake")
}
func (k sshKeyZPublicKey) Verify([]byte, *gossh.Signature) error { return nil }

type sshKeyZCryptoPublicKey struct {
	sshKeyZPublicKey
	key crypto.PublicKey
}

func (k sshKeyZCryptoPublicKey) CryptoPublicKey() crypto.PublicKey {
	return k.key
}
