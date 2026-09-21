package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSshKey_Cov_ListFiltersAndParseRejectsMultipleKeys(t *testing.T) {
	now := time.Now().UTC()
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		listUserSSHKeysFn: func(context.Context, int64) ([]db.SshKey, error) {
			return []db.SshKey{
				{ID: 1, UserID: 7, Name: "mine", Fingerprint: "fp1", KeyType: "ssh-ed25519", CreatedAt: now},
				{ID: 2, UserID: 99, Name: "other", Fingerprint: "fp2", KeyType: "ssh-ed25519", CreatedAt: now},
			}, nil
		},
	})
	keys, err := svc.ListKeys(context.Background(), 7)
	if err != nil {
		t.Fatalf("ListKeys returned error: %v", err)
	}
	if len(keys) != 1 || keys[0].Name != "mine" {
		t.Fatalf("keys = %+v", keys)
	}

	first := mustGenerateEd25519AuthorizedKey(t)
	second := mustGenerateEd25519AuthorizedKey(t)
	if _, _, err := parseAuthorizedKey(first + "\n" + second); err == nil || !strings.Contains(err.Error(), "multiple keys") {
		t.Fatalf("multiple key err = %v", err)
	}
}

func TestSshKey_Cov_CreateDuplicateLookupAndCreateErrors(t *testing.T) {
	key := mustGenerateEd25519AuthorizedKey(t)
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByFingerprintFn: func(context.Context, string) (db.SshKey, error) {
			return db.SshKey{}, errors.New("lookup failed")
		},
	})
	_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{Title: "laptop", Key: key})
	assertAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByFingerprintFn: func(context.Context, string) (db.SshKey, error) {
			return db.SshKey{}, pgx.ErrNoRows
		},
		createSSHKeyFn: func(context.Context, db.CreateSSHKeyParams) (db.SshKey, error) {
			return db.SshKey{}, errors.New("duplicate key value violates unique constraint")
		},
	})
	_, err = svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{Title: "laptop", Key: key})
	assertAPIErrorStatus(t, err, http.StatusConflict)
}

func TestSshKey_Cov_ValidateNilCryptoPublicKey(t *testing.T) {
	if err := validatePublicKey(sshKeyCovPlainPublicKey{}); err == nil || !strings.Contains(err.Error(), "unsupported key type") {
		t.Fatalf("validatePublicKey err = %v", err)
	}
}

type sshKeyCovPlainPublicKey struct{}

func (sshKeyCovPlainPublicKey) Type() string                        { return "plain" }
func (sshKeyCovPlainPublicKey) Marshal() []byte                     { return []byte("plain") }
func (sshKeyCovPlainPublicKey) Verify([]byte, *ssh.Signature) error { return nil }
