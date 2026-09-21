package services

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockSSHKeyQuerier struct {
	listUserSSHKeysFn        func(ctx context.Context, userID int64) ([]db.SshKey, error)
	createSSHKeyFn           func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error)
	getSSHKeyByIDFn          func(ctx context.Context, id int64) (db.SshKey, error)
	getSSHKeyByFingerprintFn func(ctx context.Context, fingerprint string) (db.SshKey, error)
	deleteSSHKeyFn           func(ctx context.Context, arg db.DeleteSSHKeyParams) error
}

func (m mockSSHKeyQuerier) ListUserSSHKeys(ctx context.Context, userID int64) ([]db.SshKey, error) {
	if m.listUserSSHKeysFn != nil {
		return m.listUserSSHKeysFn(ctx, userID)
	}
	return nil, nil
}

func (m mockSSHKeyQuerier) CreateSSHKey(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
	if m.createSSHKeyFn != nil {
		return m.createSSHKeyFn(ctx, arg)
	}
	return db.SshKey{}, nil
}

func (m mockSSHKeyQuerier) GetSSHKeyByID(ctx context.Context, id int64) (db.SshKey, error) {
	if m.getSSHKeyByIDFn != nil {
		return m.getSSHKeyByIDFn(ctx, id)
	}
	return db.SshKey{}, nil
}

func (m mockSSHKeyQuerier) GetSSHKeyByFingerprint(ctx context.Context, fingerprint string) (db.SshKey, error) {
	if m.getSSHKeyByFingerprintFn != nil {
		return m.getSSHKeyByFingerprintFn(ctx, fingerprint)
	}
	return db.SshKey{}, nil
}

func (m mockSSHKeyQuerier) DeleteSSHKey(ctx context.Context, arg db.DeleteSSHKeyParams) error {
	if m.deleteSSHKeyFn != nil {
		return m.deleteSSHKeyFn(ctx, arg)
	}
	return nil
}

func TestSSHKeyService_FingerprintMatchesOpenSSHFormat(t *testing.T) {
	t.Parallel()

	raw := mustGenerateEd25519AuthorizedKey(t)
	parsed, _, err := parseAuthorizedKey(raw)
	require.NoError(t, err)

	got := fingerprintSHA256(parsed)
	want := ssh.FingerprintSHA256(parsed)

	assert.Equal(t, want, got)
	assert.True(t, strings.HasPrefix(got, "SHA256:"))
}

func TestSSHKeyService_CreateKey_ValidAlgorithms(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		keyFactory  func(t *testing.T) string
		wantKeyType string
	}{
		{
			name:        "accepts ed25519",
			keyFactory:  mustGenerateEd25519AuthorizedKey,
			wantKeyType: "ssh-ed25519",
		},
		{
			name: "accepts rsa 2048",
			keyFactory: func(t *testing.T) string {
				return mustGenerateRSAAuthorizedKey(t, 2048)
			},
			wantKeyType: "ssh-rsa",
		},
		{
			name: "accepts ecdsa p256",
			keyFactory: func(t *testing.T) string {
				return mustGenerateECDSAAuthorizedKey(t, elliptic.P256())
			},
			wantKeyType: "ecdsa-sha2-nistp256",
		},
		{
			name: "accepts ecdsa p384",
			keyFactory: func(t *testing.T) string {
				return mustGenerateECDSAAuthorizedKey(t, elliptic.P384())
			},
			wantKeyType: "ecdsa-sha2-nistp384",
		},
		{
			name: "accepts ecdsa p521",
			keyFactory: func(t *testing.T) string {
				return mustGenerateECDSAAuthorizedKey(t, elliptic.P521())
			},
			wantKeyType: "ecdsa-sha2-nistp521",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var createArg db.CreateSSHKeyParams
			now := time.Now().UTC().Truncate(time.Second)
			svc := NewSSHKeyService(mockSSHKeyQuerier{
				getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
					return db.SshKey{}, pgx.ErrNoRows
				},
				createSSHKeyFn: func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
					createArg = arg
					return db.SshKey{
						ID:          9,
						UserID:      arg.UserID,
						Name:        arg.Name,
						PublicKey:   arg.PublicKey,
						Fingerprint: arg.Fingerprint,
						KeyType:     arg.KeyType,
						CreatedAt:   now,
					}, nil
				},
			})

			resp, err := svc.CreateKey(context.Background(), 42, CreateSSHKeyRequest{
				Title: "laptop",
				Key:   tc.keyFactory(t),
			})
			require.NoError(t, err)
			assert.Equal(t, tc.wantKeyType, createArg.KeyType)
			assert.Equal(t, tc.wantKeyType, resp.KeyType)
		})
	}
}

func TestSSHKeyService_CreateKey_RejectsWeakOrUnsupportedKeys(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		key  func(t *testing.T) string
	}{
		{
			name: "rejects rsa 1024",
			key: func(t *testing.T) string {
				return mustGenerateRSAAuthorizedKey(t, 1024)
			},
		},
		{
			name: "rejects unsupported key type",
			key: func(t *testing.T) string {
				return unsupportedDSAAuthorizedKey
			},
		},
		{
			name: "rejects malformed authorized key",
			key: func(t *testing.T) string {
				return "not-an-authorized-key"
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			svc := NewSSHKeyService(mockSSHKeyQuerier{})
			_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{
				Title: "bad",
				Key:   tc.key(t),
			})

			assertAPIErrorStatus(t, err, http.StatusUnprocessableEntity)
		})
	}
}

func TestSSHKeyService_CreateKey_DetectsDuplicateFingerprint(t *testing.T) {
	t.Parallel()

	key := mustGenerateEd25519AuthorizedKey(t)
	createCalled := false

	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
			return db.SshKey{ID: 100, UserID: 2, Fingerprint: fingerprint}, nil
		},
		createSSHKeyFn: func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
			createCalled = true
			return db.SshKey{}, nil
		},
	})

	_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{Title: "laptop", Key: key})
	assertAPIErrorStatus(t, err, http.StatusConflict)
	assert.False(t, createCalled)
}

func TestSSHKeyService_CreateKey_PersistsCanonicalKeyAndMetadata(t *testing.T) {
	t.Parallel()

	raw := mustGenerateEd25519AuthorizedKeyWithComment(t, "test-comment")
	parsed, _, _, _, err := ssh.ParseAuthorizedKey([]byte(raw))
	require.NoError(t, err)

	wantCanonical := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(parsed)))
	wantFingerprint := ssh.FingerprintSHA256(parsed)

	var createArg db.CreateSSHKeyParams
	now := time.Now().UTC().Truncate(time.Second)
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
			return db.SshKey{}, pgx.ErrNoRows
		},
		createSSHKeyFn: func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
			createArg = arg
			return db.SshKey{
				ID:          3,
				UserID:      arg.UserID,
				Name:        arg.Name,
				PublicKey:   arg.PublicKey,
				Fingerprint: arg.Fingerprint,
				KeyType:     arg.KeyType,
				CreatedAt:   now,
			}, nil
		},
	})

	resp, err := svc.CreateKey(context.Background(), 44, CreateSSHKeyRequest{
		Title: "my-laptop",
		Key:   raw,
	})
	require.NoError(t, err)

	assert.Equal(t, int64(44), createArg.UserID)
	assert.Equal(t, "my-laptop", createArg.Name)
	assert.Equal(t, wantCanonical, createArg.PublicKey)
	assert.Equal(t, wantFingerprint, createArg.Fingerprint)
	assert.Equal(t, "ssh-ed25519", createArg.KeyType)

	assert.Equal(t, int64(3), resp.ID)
	assert.Equal(t, "my-laptop", resp.Name)
	assert.Equal(t, wantFingerprint, resp.Fingerprint)
	assert.Equal(t, "ssh-ed25519", resp.KeyType)
}

func TestSSHKeyService_ListKeys_SanitizesPublicKeyMaterial(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		listUserSSHKeysFn: func(ctx context.Context, userID int64) ([]db.SshKey, error) {
			assert.Equal(t, int64(50), userID)
			return []db.SshKey{
				{
					ID:          11,
					UserID:      userID,
					Name:        "devbox",
					PublicKey:   "ssh-ed25519 AAAA...",
					Fingerprint: "SHA256:abc",
					KeyType:     "ssh-ed25519",
					CreatedAt:   now,
				},
			}, nil
		},
	})

	keys, err := svc.ListKeys(context.Background(), 50)
	require.NoError(t, err)
	require.Len(t, keys, 1)

	assert.Equal(t, int64(11), keys[0].ID)
	assert.Equal(t, "devbox", keys[0].Name)
	assert.Equal(t, "SHA256:abc", keys[0].Fingerprint)
	assert.Equal(t, "ssh-ed25519", keys[0].KeyType)
	assert.Equal(t, now, keys[0].CreatedAt)

	jsonBody, err := json.Marshal(keys[0])
	require.NoError(t, err)
	assert.NotContains(t, string(jsonBody), "public_key")
}

func TestSSHKeyService_ListKeys_Errors(t *testing.T) {
	t.Parallel()

	svc := NewSSHKeyService(mockSSHKeyQuerier{})
	errStatus := assertAPIErrorStatus(t, func() error {
		_, err := svc.ListKeys(context.Background(), 0)
		return err
	}(), http.StatusBadRequest)
	assert.Equal(t, "invalid user", errStatus.Message)

	svc = NewSSHKeyService(mockSSHKeyQuerier{
		listUserSSHKeysFn: func(ctx context.Context, userID int64) ([]db.SshKey, error) {
			return nil, stdErrors.New("boom")
		},
	})
	_, err := svc.ListKeys(context.Background(), 22)
	assertAPIErrorStatus(t, err, http.StatusInternalServerError)
}

func TestSSHKeyService_GetKeyByID_OwnershipEnforced(t *testing.T) {
	t.Parallel()

	t.Run("owned key returns key", func(t *testing.T) {
		now := time.Now().UTC().Truncate(time.Second)
		svc := NewSSHKeyService(mockSSHKeyQuerier{
			getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
				assert.Equal(t, int64(8), id)
				return db.SshKey{
					ID:          8,
					UserID:      15,
					Name:        "laptop",
					PublicKey:   "ssh-ed25519 AAAA",
					Fingerprint: "SHA256:def",
					KeyType:     "ssh-ed25519",
					CreatedAt:   now,
				}, nil
			},
		})

		resp, err := svc.GetKeyByID(context.Background(), 15, 8)
		require.NoError(t, err)
		assert.Equal(t, int64(8), resp.ID)
		assert.Equal(t, "SHA256:def", resp.Fingerprint)
	})

	t.Run("foreign key returns not found", func(t *testing.T) {
		svc := NewSSHKeyService(mockSSHKeyQuerier{
			getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
				return db.SshKey{ID: id, UserID: 999}, nil
			},
		})

		_, err := svc.GetKeyByID(context.Background(), 15, 8)
		assertAPIErrorStatus(t, err, http.StatusNotFound)
	})
}

func TestSSHKeyService_GetKeyByID_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{}, pgx.ErrNoRows
		},
	})

	_, err := svc.GetKeyByID(context.Background(), 1, 999)
	assertAPIErrorStatus(t, err, http.StatusNotFound)
}

func TestSSHKeyService_GetKeyByID_ValidationAndInternalErrors(t *testing.T) {
	t.Parallel()

	svc := NewSSHKeyService(mockSSHKeyQuerier{})

	_, err := svc.GetKeyByID(context.Background(), 0, 1)
	assertAPIErrorStatus(t, err, http.StatusBadRequest)

	_, err = svc.GetKeyByID(context.Background(), 1, 0)
	assertAPIErrorStatus(t, err, http.StatusBadRequest)

	svc = NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{}, stdErrors.New("db down")
		},
	})

	_, err = svc.GetKeyByID(context.Background(), 1, 5)
	assertAPIErrorStatus(t, err, http.StatusInternalServerError)
}

func TestSSHKeyService_DeleteKey_OwnedKeyDeletes(t *testing.T) {
	t.Parallel()

	deleted := false
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			assert.Equal(t, int64(14), id)
			return db.SshKey{ID: id, UserID: 88}, nil
		},
		deleteSSHKeyFn: func(ctx context.Context, arg db.DeleteSSHKeyParams) error {
			deleted = true
			assert.Equal(t, int64(14), arg.ID)
			assert.Equal(t, int64(88), arg.UserID)
			return nil
		},
	})

	err := svc.DeleteKey(context.Background(), 88, 14)
	require.NoError(t, err)
	assert.True(t, deleted)
}

func TestSSHKeyService_DeleteKey_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{}, pgx.ErrNoRows
		},
	})

	err := svc.DeleteKey(context.Background(), 1, 14)
	assertAPIErrorStatus(t, err, http.StatusNotFound)
}

func TestSSHKeyService_DeleteKey_ForeignOwnerReturns404(t *testing.T) {
	t.Parallel()

	deleteCalled := false
	svc := NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{ID: id, UserID: 2}, nil
		},
		deleteSSHKeyFn: func(ctx context.Context, arg db.DeleteSSHKeyParams) error {
			deleteCalled = true
			return nil
		},
	})

	err := svc.DeleteKey(context.Background(), 1, 55)
	assertAPIErrorStatus(t, err, http.StatusNotFound)
	assert.False(t, deleteCalled)
}

func TestSSHKeyService_DeleteKey_ValidationAndInternalErrors(t *testing.T) {
	t.Parallel()

	svc := NewSSHKeyService(mockSSHKeyQuerier{})

	err := svc.DeleteKey(context.Background(), 0, 1)
	assertAPIErrorStatus(t, err, http.StatusBadRequest)

	err = svc.DeleteKey(context.Background(), 1, 0)
	assertAPIErrorStatus(t, err, http.StatusBadRequest)

	svc = NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{}, stdErrors.New("read failed")
		},
	})
	err = svc.DeleteKey(context.Background(), 1, 2)
	assertAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = NewSSHKeyService(mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(ctx context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{ID: id, UserID: 9}, nil
		},
		deleteSSHKeyFn: func(ctx context.Context, arg db.DeleteSSHKeyParams) error {
			return stdErrors.New("delete failed")
		},
	})
	err = svc.DeleteKey(context.Background(), 9, 2)
	assertAPIErrorStatus(t, err, http.StatusInternalServerError)
}

func TestSSHKeyService_CreateKey_QueryAndInsertFailures(t *testing.T) {
	t.Parallel()

	key := mustGenerateEd25519AuthorizedKey(t)

	t.Run("duplicate lookup failure returns internal", func(t *testing.T) {
		svc := NewSSHKeyService(mockSSHKeyQuerier{
			getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
				return db.SshKey{}, stdErrors.New("query failed")
			},
		})

		_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{
			Title: "laptop",
			Key:   key,
		})
		assertAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("unique violation maps to conflict", func(t *testing.T) {
		svc := NewSSHKeyService(mockSSHKeyQuerier{
			getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
				return db.SshKey{}, pgx.ErrNoRows
			},
			createSSHKeyFn: func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
				return db.SshKey{}, &pgconn.PgError{Code: "23505"}
			},
		})

		_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{
			Title: "laptop",
			Key:   key,
		})
		assertAPIErrorStatus(t, err, http.StatusConflict)
	})

	t.Run("non unique insert error returns internal", func(t *testing.T) {
		svc := NewSSHKeyService(mockSSHKeyQuerier{
			getSSHKeyByFingerprintFn: func(ctx context.Context, fingerprint string) (db.SshKey, error) {
				return db.SshKey{}, pgx.ErrNoRows
			},
			createSSHKeyFn: func(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error) {
				return db.SshKey{}, stdErrors.New("insert failed")
			},
		})

		_, err := svc.CreateKey(context.Background(), 1, CreateSSHKeyRequest{
			Title: "laptop",
			Key:   key,
		})
		assertAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("invalid user returns bad request", func(t *testing.T) {
		svc := NewSSHKeyService(mockSSHKeyQuerier{})
		_, err := svc.CreateKey(context.Background(), 0, CreateSSHKeyRequest{
			Title: "laptop",
			Key:   key,
		})
		assertAPIErrorStatus(t, err, http.StatusBadRequest)
	})
}

func TestIsSSHKeyUniqueViolation(t *testing.T) {
	t.Parallel()

	assert.False(t, isSSHKeyUniqueViolation(nil))
	assert.True(t, isSSHKeyUniqueViolation(&pgconn.PgError{Code: "23505"}))
	assert.False(t, isSSHKeyUniqueViolation(&pgconn.PgError{Code: "23514"}))
	assert.True(t, isSSHKeyUniqueViolation(stdErrors.New("duplicate key value violates unique constraint")))
	assert.True(t, isSSHKeyUniqueViolation(stdErrors.New("UNIQUE constraint failed")))
	assert.False(t, isSSHKeyUniqueViolation(stdErrors.New("other db failure")))
}

func assertAPIErrorStatus(t *testing.T, err error, wantStatus int) *pkgerrors.APIError {
	t.Helper()
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, wantStatus, apiErr.Status)
	return apiErr
}

func mustGenerateEd25519AuthorizedKey(t *testing.T) string {
	t.Helper()
	return mustGenerateEd25519AuthorizedKeyWithComment(t, "test")
}

func mustGenerateEd25519AuthorizedKeyWithComment(t *testing.T, comment string) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	return mustMarshalAuthorizedKey(t, pub, comment)
}

func mustGenerateRSAAuthorizedKey(t *testing.T, bits int) string {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, bits)
	require.NoError(t, err)
	return mustMarshalAuthorizedKey(t, &priv.PublicKey, "rsa")
}

func mustGenerateECDSAAuthorizedKey(t *testing.T, curve elliptic.Curve) string {
	t.Helper()
	priv, err := ecdsa.GenerateKey(curve, rand.Reader)
	require.NoError(t, err)
	return mustMarshalAuthorizedKey(t, &priv.PublicKey, "ecdsa")
}

func mustMarshalAuthorizedKey(t *testing.T, publicKey any, comment string) string {
	t.Helper()

	sshPub, err := ssh.NewPublicKey(publicKey)
	require.NoError(t, err)

	canonical := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub)))
	if comment == "" {
		return canonical
	}
	return canonical + " " + comment
}

const unsupportedDSAAuthorizedKey = "ssh-dss AAAAB3NzaC1kc3MAAACBAJzSfp7Oe2WYcBquvnthAKfTfUJ0G+l2mEmfVJn2LjRzQumhZa0O0Yw5254bbTbc1vKATrnpbAi6idT8hkJCG/sDNTDjSNoQBH6o1Kb3yNlOJwFepVl//OwWFciy3auRiuSVRt9YsVwGX2yjbSGtNxVZhmUs2aimlvZFvBnsK/sBAAAAFQDQ544BENWXU9bUx41MfvGIEP1JCwAAAIBeAFUCPx5Ahid3w2oq43mK9RsWuiP6De/XzDrdaNLvAFhQSl5KNSHz6ZSgbNvpb1YtckKkDkODVDaEa/C4SPKAjiOQQQAUhZL2zg04K6AUOuvWajLZZtvP7jvC+sYACT5osN9bNGH9gkQorKmLPdsO0Xrdcz45IHO2m9ZjMoeK8wAAAIBG0n2oSSkGqIpzZVZZKq+f8nP7Ikgx9CiDSBqP/LbxMBwp6ZUywTLbVXIUfwCXxnLO4lmyqa/7VtEEFb2hccVYBmtOaRmsVJtxVqRdqpJeX18tCY3iyrhjbtDNcMFzkfG4jS6baIowUjue/biCxzCfY+U1TT9pLw4uynS4SgoECg== test-dsa"
