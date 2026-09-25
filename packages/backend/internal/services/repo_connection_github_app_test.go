package services

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestRepoConnectionService_GetGitHubAppStatus_InstalledViaUserRepoMapping(t *testing.T) {
	t.Setenv(envGitHubAppInstallURL, "https://github.example/install")

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			assert.Contains(t, sql, "FROM repo_connections rc")
			require.Len(t, args, 3)
			assert.Equal(t, int64(7), args[0])
			assert.Equal(t, "acme", args[1])
			assert.Equal(t, "repo", args[2])
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 555
				return nil
			}}
		},
	})

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "Acme", "Repo")
	require.NoError(t, err)
	assert.True(t, status.GitHubAppInstalled)
	assert.Equal(t, int64(555), status.InstallationID)
	assert.Equal(t, "https://github.example/install", status.InstallURL)
	assert.Equal(t, "Acme", status.Owner)
	assert.Equal(t, "Repo", status.Repo)
}

func TestRepoConnectionService_GetGitHubAppStatus_FallsBackToRepoMapping(t *testing.T) {
	queryCount := 0
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			queryCount++
			if queryCount == 1 {
				return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
			}
			assert.Contains(t, sql, "FROM github_app_installation_repositories")
			assert.Contains(t, sql, "is_private = FALSE")
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*bool)) = true
				return nil
			}}
		},
	})

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "acme", "repo")
	require.NoError(t, err)
	assert.Equal(t, 2, queryCount)
	assert.True(t, status.GitHubAppInstalled)
	assert.Equal(t, int64(0), status.InstallationID)
	assert.Equal(t, 0, status.GitHubRateLimitRemaining)
}

func TestRepoConnectionService_GetGitHubAppStatus_NotInstalled(t *testing.T) {
	// App IS configured but this repo isn't installed: the install prompt is
	// legitimate here, so the default install URL must be surfaced.
	t.Setenv(envGitHubAppID, "12345")
	t.Setenv(envGitHubAppPrivateKey, testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppInstallURL, "")

	queryCount := 0
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			queryCount++
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	})

	status, err := svc.GetGitHubAppStatus(context.Background(), 7, "acme", "repo")
	require.NoError(t, err)
	assert.Equal(t, 2, queryCount)
	assert.False(t, status.GitHubAppInstalled)
	assert.True(t, status.GitHubAppConfigured)
	assert.Equal(t, int64(0), status.InstallationID)
	assert.Contains(t, status.InstallURL, "installations/new")
}

func TestRepoConnectionService_CreateGitHubInstallationToken_Success(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})

	expiresAt := time.Date(2026, 4, 26, 20, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/app/installations/9001/access_tokens", r.URL.Path)
		assert.Equal(t, "application/vnd.github+json", r.Header.Get("Accept"))
		authHeader := r.Header.Get("Authorization")
		assert.True(t, strings.HasPrefix(authHeader, "Bearer "))
		assertGitHubAppJWTIsValid(t, strings.TrimPrefix(authHeader, "Bearer "), &privateKey.PublicKey, int64(12345))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"ghs_test_token","expires_at":"` + expiresAt.Format(time.RFC3339) + `"}`))
	}))
	defer server.Close()

	t.Setenv(envGitHubAppID, "12345")
	t.Setenv(envGitHubAppPrivateKey, string(privateKeyPEM))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 9001
				return nil
			}}
		},
	})

	token, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "acme", "repo")
	require.NoError(t, err)
	assert.Equal(t, int64(9001), token.InstallationID)
	assert.Equal(t, "ghs_test_token", token.Token)
	assert.Equal(t, expiresAt, token.ExpiresAt)
}

// TestRepoConnectionService_CreateGitHubInstallationToken_CachesWithinWindow
// verifies a still-fresh installation token is served from cache: the proxy /
// repo-list / check-runs all call this PER REQUEST and installation tokens are
// valid ~1h, so a second call within the window must NOT re-mint from GitHub.
// Uses a distinct installation id + explicit cache reset (the cache is a package
// var) so it neither pollutes nor is polluted by other tests.
func TestRepoConnectionService_CreateGitHubInstallationToken_CachesWithinWindow(t *testing.T) {
	const installationID = int64(9002)
	invalidateCachedInstallationToken(installationID)
	defer invalidateCachedInstallationToken(installationID)

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})

	mintCount := 0
	// Well beyond the 5-min early-expiry margin so the cache serves the 2nd call.
	expiresAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mintCount++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"ghs_cached_token","expires_at":"` + expiresAt.Format(time.RFC3339) + `"}`))
	}))
	defer server.Close()

	t.Setenv(envGitHubAppID, "12345")
	t.Setenv(envGitHubAppPrivateKey, string(privateKeyPEM))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = installationID
				return nil
			}}
		},
	})

	first, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "acme", "repo")
	require.NoError(t, err)
	assert.Equal(t, "ghs_cached_token", first.Token)

	second, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "acme", "repo")
	require.NoError(t, err)
	assert.Equal(t, "ghs_cached_token", second.Token)

	assert.Equal(t, 1, mintCount, "the installation token is minted from GitHub only once within its validity window")
}

func TestRepoConnectionService_CreateGitHubInstallationToken_RequiresInstallation(t *testing.T) {
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	})

	_, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "acme", "repo")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
	assert.Equal(t, "github app is not installed for this repository", apiErr.Message)
}

func TestRepoConnectionService_CreateGitHubInstallationToken_DoesNotUseUnscopedRepoFallback(t *testing.T) {
	queryCount := 0
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			queryCount++
			require.Contains(t, sql, "FROM repo_connections rc")
			require.Len(t, args, 3)
			assert.Equal(t, int64(11), args[0])
			assert.Equal(t, "victim", args[1])
			assert.Equal(t, "repo", args[2])
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	})

	_, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "Victim", "Repo")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
	assert.Equal(t, "github app is not installed for this repository", apiErr.Message)
	assert.Equal(t, 1, queryCount)
}

func TestRepoConnectionService_CreateGitHubInstallationTokenForImportedSource_UsesReadyImportProvenanceAndPublicInstallation(t *testing.T) {
	const installationID = int64(9901)
	invalidateCachedInstallationToken(installationID)
	defer invalidateCachedInstallationToken(installationID)

	expiresAt := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/repos/smithersai/smithers" {
			_, _ = w.Write([]byte(`{"private":false}`))
			return
		}
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/app/installations/9901/access_tokens", r.URL.Path)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"ghs_imported_public","expires_at":"` + expiresAt.Format(time.RFC3339) + `"}`))
	}))
	defer server.Close()

	t.Setenv(envGitHubAppID, "12345")
	t.Setenv(envGitHubAppPrivateKey, testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var queries []string
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			queries = append(queries, sql)
			switch len(queries) {
			case 1:
				assert.Contains(t, sql, "FROM import_jobs")
				require.Len(t, args, 4)
				assert.Equal(t, int64(8), args[0])
				assert.Equal(t, int64(333), args[1])
				assert.Equal(t, "smithersai", args[2])
				assert.Equal(t, "smithers", args[3])
				return mockRepoConnectionRow{scanFn: func(dest ...any) error {
					*(dest[0].(*bool)) = true
					return nil
				}}
			case 2:
				assert.Contains(t, sql, "FROM github_app_installation_repositories")
				assert.Contains(t, sql, "is_private = FALSE")
				require.Len(t, args, 2)
				assert.Equal(t, "smithersai", args[0])
				assert.Equal(t, "smithers", args[1])
				return mockRepoConnectionRow{scanFn: func(dest ...any) error {
					*(dest[0].(*int64)) = installationID
					return nil
				}}
			default:
				t.Fatalf("unexpected extra DB query %d: %s", len(queries), sql)
				return mockRepoConnectionRow{}
			}
		},
	})

	token, err := svc.CreateGitHubInstallationTokenForImportedSource(context.Background(), 8, 333, "SmithersAI", "Smithers")
	require.NoError(t, err)
	assert.Equal(t, installationID, token.InstallationID)
	assert.Equal(t, "ghs_imported_public", token.Token)
	assert.Equal(t, expiresAt, token.ExpiresAt)
	assert.Len(t, queries, 2)
}

func TestRepoConnectionService_CreateGitHubInstallationToken_RequiresCredentials(t *testing.T) {
	t.Setenv(envGitHubAppID, "")
	t.Setenv(envGitHubAppPrivateKey, "")

	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 123
				return nil
			}}
		},
	})

	_, err := svc.CreateGitHubInstallationToken(context.Background(), 11, "acme", "repo")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	assert.Equal(t, "github app id is not configured", apiErr.Message)
}

func TestCreateGitHubAppJWT_WithGeneratedRSAKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	now := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)
	token, err := createGitHubAppJWT(12345, key, now)
	require.NoError(t, err)

	parts := strings.Split(token, ".")
	require.Len(t, parts, 3)

	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(t, err)
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	require.NoError(t, json.Unmarshal(headerJSON, &header))
	assert.Equal(t, "RS256", header.Alg)
	assert.Equal(t, "JWT", header.Typ)

	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	var payload struct {
		Iss int64 `json:"iss"`
		Iat int64 `json:"iat"`
		Exp int64 `json:"exp"`
	}
	require.NoError(t, json.Unmarshal(payloadJSON, &payload))
	assert.Equal(t, int64(12345), payload.Iss)
	assert.Equal(t, now.Add(-30*time.Second).Unix(), payload.Iat)
	assert.Equal(t, now.Add(9*time.Minute).Unix(), payload.Exp)

	assertGitHubAppJWTIsValid(t, token, &key.PublicKey, 12345)
}

func assertGitHubAppJWTIsValid(t *testing.T, token string, publicKey *rsa.PublicKey, expectedIssuer int64) {
	t.Helper()

	parts := strings.Split(token, ".")
	require.Len(t, parts, 3)

	signedPart := parts[0] + "." + parts[1]
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	require.NoError(t, err)

	digest := sha256.Sum256([]byte(signedPart))
	require.NoError(t, rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], signature))

	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	var payload struct {
		Iss int64 `json:"iss"`
	}
	require.NoError(t, json.Unmarshal(payloadJSON, &payload))
	assert.Equal(t, expectedIssuer, payload.Iss)
}
