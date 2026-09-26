package flowhost

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ModelCredentialPrefix marks a managed host's platform-model credential.
const ModelCredentialPrefix = "smithers_flowhost_"

// ErrModelCredentialInvalid refuses a model credential that names no live
// binding or does not match it.
var ErrModelCredentialInvalid = errors.New("flow host model credential is invalid")

// ModelCredential is the credential a managed host spends platform models
// with, an HMAC of the binding's control credential. Holding it grants no
// control over the host, and forging it needs the control credential itself,
// which is stored only encrypted.
func ModelCredential(bindingID, credential string) string {
	mac := hmac.New(sha256.New, []byte(credential))
	mac.Write([]byte("smithers-model-proxy:" + bindingID))
	return ModelCredentialPrefix + bindingID + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// ModelCredentialBinding is the live binding a model credential belongs to.
type ModelCredentialBinding struct {
	ID           string
	UserID       int64
	RepositoryID int64
	WorkspaceID  string
}

// VerifyModelCredential resolves a model credential to its binding. A
// retired binding, or one whose control credential rotated, is refused.
func VerifyModelCredential(ctx context.Context, pool *pgxpool.Pool, codec SecretCodec, token string) (ModelCredentialBinding, error) {
	rest, ok := strings.CutPrefix(token, ModelCredentialPrefix)
	if !ok || pool == nil || codec == nil {
		return ModelCredentialBinding{}, ErrModelCredentialInvalid
	}
	id, mac, ok := strings.Cut(rest, ".")
	if _, err := uuid.Parse(id); !ok || err != nil || mac == "" {
		return ModelCredentialBinding{}, ErrModelCredentialInvalid
	}
	var out ModelCredentialBinding
	var encrypted string
	var credentialHash []byte
	err := pool.QueryRow(ctx, `SELECT id::text, user_id, repository_id, workspace_id, credential_ciphertext, credential_hash
		FROM flow_runtime_host_bindings WHERE id = $1::uuid AND state <> 'retired'`, id).
		Scan(&out.ID, &out.UserID, &out.RepositoryID, &out.WorkspaceID, &encrypted, &credentialHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ModelCredentialBinding{}, ErrModelCredentialInvalid
	}
	if err != nil {
		return ModelCredentialBinding{}, err
	}
	credential, err := codec.DecryptString(encrypted)
	if err != nil {
		return ModelCredentialBinding{}, errors.New("open flow host credential")
	}
	digest := sha256.Sum256([]byte(credential))
	if !hmac.Equal(digest[:], credentialHash) || !hmac.Equal([]byte(token), []byte(ModelCredential(out.ID, credential))) {
		return ModelCredentialBinding{}, ErrModelCredentialInvalid
	}
	return out, nil
}
