package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockUserQuerier struct {
	getAuthInfoByTokenHashFn     func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	getOAuth2AccessTokenByHashFn func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	getUserByIDFn                func(ctx context.Context, id int64) (db.User, error)
	getAuthInfoByTokenHashCalls  int
}

func (m *mockUserQuerier) GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	m.getAuthInfoByTokenHashCalls++
	if m.getAuthInfoByTokenHashFn != nil {
		return m.getAuthInfoByTokenHashFn(ctx, tokenHash)
	}
	return db.GetAuthInfoByTokenHashRow{}, assert.AnError
}

func (m *mockUserQuerier) GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
	if m.getOAuth2AccessTokenByHashFn != nil {
		return m.getOAuth2AccessTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (m *mockUserQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, pgx.ErrNoRows
}

func TestExtractToken(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		authorization string
		want          string
	}{
		{
			name:          "valid bearer token",
			authorization: "Bearer smithers_0123456789abcdef0123456789abcdef01234567",
			want:          "smithers_0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:          "valid token scheme",
			authorization: "token smithers_0123456789abcdef0123456789abcdef01234567",
			want:          "smithers_0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:          "valid token scheme uppercase",
			authorization: "TOKEN smithers_0123456789abcdef0123456789abcdef01234567",
			want:          "smithers_0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:          "valid bearer scheme lowercase",
			authorization: "bearer smithers_0123456789abcdef0123456789abcdef01234567",
			want:          "smithers_0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:          "missing header",
			authorization: "",
			want:          "",
		},
		{
			name:          "basic credentials without token password",
			authorization: "Basic dXNlcjpwYXNz",
			want:          "",
		},
		{
			name:          "valid basic token password",
			authorization: "Basic dXNlcjpzbWl0aGVyc18wMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3",
			want:          "smithers_0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:          "basic token requires username",
			authorization: "Basic OnNtaXRoZXJzXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc=",
			want:          "",
		},
		{
			name:          "bearer token missing smithers prefix",
			authorization: "Bearer deadbeef0123456789abcdef0123456789abcdef",
			want:          "",
		},
		{
			name:          "malformed token wrong length",
			authorization: "Bearer smithers_deadbeef",
			want:          "",
		},
		{
			name:          "malformed token non hex tail",
			authorization: "Bearer smithers_0123456789abcdef0123456789abcdef0123456g",
			want:          "",
		},
		{
			name:          "valid oauth2 bearer token",
			authorization: "Bearer smithers_oat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			want:          "smithers_oat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.authorization != "" {
				r.Header.Set("Authorization", tc.authorization)
			}

			assert.Equal(t, tc.want, ExtractToken(r))
		})
	}
}

func TestExtractToken_IgnoresQueryParamTokens(t *testing.T) {
	t.Parallel()

	r := httptest.NewRequest(http.MethodGet, "/api/notifications?token=smithers_0123456789abcdef0123456789abcdef01234567", nil)
	assert.Equal(t, "", ExtractToken(r))
}

func TestTokenAuth_ValidToken(t *testing.T) {
	t.Parallel()

	token := "smithers_0123456789abcdef0123456789abcdef01234567"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:          1,
				Username:    "testuser",
				TokenID:     33,
				TokenScopes: "write:repository",
			}, nil
		},
	}

	var capturedUser *db.User
	var capturedAuthInfo *AuthInfo
	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		capturedAuthInfo = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusOK, w.Code)
	require.NotNil(t, capturedUser)
	assert.Equal(t, "testuser", capturedUser.Username)
	require.NotNil(t, capturedAuthInfo)
	assert.Equal(t, int64(33), capturedAuthInfo.TokenID)
	assert.True(t, capturedAuthInfo.IsTokenAuth)
	assert.True(t, capturedAuthInfo.Scopes.Has(ScopeWriteRepository))
	assert.Equal(t, TokenSourcePersonalAccessToken, capturedAuthInfo.TokenSource)
}

func TestTokenAuth_RejectsMalformedTokenWithoutDBLookup(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			t.Fatalf("db lookup must not happen for malformed token: %s", tokenHash)
			return db.GetAuthInfoByTokenHashRow{}, nil
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer not_smithers_prefix")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Equal(t, 0, q.getAuthInfoByTokenHashCalls)
}

func TestTokenAuth_NoToken(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestTokenAuth_ValidOAuth2Token(t *testing.T) {
	t.Parallel()

	token := "smithers_oat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.Oauth2AccessToken{
				ID:     44,
				UserID: 5,
				Scopes: []string{"read:user", "write:repository"},
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			require.Equal(t, int64(5), id)
			return db.User{
				ID:            5,
				Username:      "oauth-app-user",
				LowerUsername: "oauth-app-user",
				IsActive:      true,
			}, nil
		},
	}

	var capturedAuthInfo *AuthInfo
	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuthInfo = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	require.Equal(t, http.StatusOK, w.Code)
	require.NotNil(t, capturedAuthInfo)
	assert.Equal(t, int64(44), capturedAuthInfo.TokenID)
	assert.True(t, capturedAuthInfo.Scopes.Has(ScopeReadUser))
	assert.True(t, capturedAuthInfo.Scopes.Has(ScopeWriteRepository))
	assert.Equal(t, TokenSourceOAuth2AccessToken, capturedAuthInfo.TokenSource)
}

func TestTokenAuth_TokenNotFound(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Equal(t, "invalid or expired token", apiErrorMessage(t, w))
}

func TestTokenAuth_DBFailureReturnsInternal(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, assert.AnError
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Equal(t, "internal server error", apiErrorMessage(t, w))
}

func TestTokenAuth_SetsAuthInfoInContext(t *testing.T) {
	t.Parallel()

	token := "smithers_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:          42,
				Username:    "alice",
				TokenID:     999,
				TokenScopes: "read:repository,write:user",
			}, nil
		},
	}

	var gotUser *db.User
	var gotAuth *AuthInfo
	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser = UserFromContext(r.Context())
		gotAuth = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "token "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)

	require.Equal(t, http.StatusNoContent, w.Code)
	require.NotNil(t, gotUser)
	assert.Equal(t, int64(42), gotUser.ID)
	assert.Equal(t, "alice", gotUser.Username)

	require.NotNil(t, gotAuth)
	assert.Equal(t, int64(999), gotAuth.TokenID)
	assert.Equal(t, "read:repository,write:user", gotAuth.RawScopes)
	assert.True(t, gotAuth.IsTokenAuth)
	assert.True(t, gotAuth.Scopes.Has(ScopeReadRepository))
	assert.True(t, gotAuth.Scopes.Has(ScopeWriteUser))
}

func apiErrorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	return payload.Message
}

type mockAuthLoaderQuerier struct {
	getAuthSessionBySessionKeyFn  func(ctx context.Context, sessionKey string) (db.AuthSession, error)
	refreshAuthSessionFn          func(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error)
	getAuthInfoByTokenHashFn      func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	getOAuth2AccessTokenByHashFn  func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	updateAccessTokenLastUsedFn   func(ctx context.Context, id int64) error
	getUserByIDFn                 func(ctx context.Context, id int64) (db.User, error)
	getAuthSessionBySessionKeyHit int
	refreshAuthSessionHit         int
	getAuthInfoByTokenHashHit     int
	getOAuth2AccessTokenByHashHit int
	updateAccessTokenLastUsedHit  int
	getUserByIDHit                int
}

func (m *mockAuthLoaderQuerier) GetAuthSessionBySessionKey(ctx context.Context, sessionKey string) (db.AuthSession, error) {
	m.getAuthSessionBySessionKeyHit++
	if m.getAuthSessionBySessionKeyFn != nil {
		return m.getAuthSessionBySessionKeyFn(ctx, sessionKey)
	}
	return db.AuthSession{}, pgx.ErrNoRows
}

func (m *mockAuthLoaderQuerier) RefreshAuthSession(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error) {
	m.refreshAuthSessionHit++
	if m.refreshAuthSessionFn != nil {
		return m.refreshAuthSessionFn(ctx, arg)
	}
	return db.AuthSession{}, assert.AnError
}

func (m *mockAuthLoaderQuerier) GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	m.getAuthInfoByTokenHashHit++
	if m.getAuthInfoByTokenHashFn != nil {
		return m.getAuthInfoByTokenHashFn(ctx, tokenHash)
	}
	return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
}

func (m *mockAuthLoaderQuerier) GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
	m.getOAuth2AccessTokenByHashHit++
	if m.getOAuth2AccessTokenByHashFn != nil {
		return m.getOAuth2AccessTokenByHashFn(ctx, tokenHash)
	}
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (m *mockAuthLoaderQuerier) UpdateAccessTokenLastUsed(ctx context.Context, id int64) error {
	m.updateAccessTokenLastUsedHit++
	if m.updateAccessTokenLastUsedFn != nil {
		return m.updateAccessTokenLastUsedFn(ctx, id)
	}
	return nil
}

func (m *mockAuthLoaderQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	m.getUserByIDHit++
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, pgx.ErrNoRows
}

func TestAuthLoader_AllowsAnonymousRequest(t *testing.T) {
	t.Parallel()

	q := &mockAuthLoaderQuerier{}

	nextCalled := false
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		require.Nil(t, UserFromContext(r.Context()))
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/public", nil)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, nextCalled)
	assert.Equal(t, 0, q.getAuthSessionBySessionKeyHit)
	assert.Equal(t, 0, q.getAuthInfoByTokenHashHit)
}

func TestRequireAuth_RejectsAnonymous(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, nextCalled)
	assert.Equal(t, "authentication required", apiErrorMessage(t, rec))
}

func TestTokenAuth_OverridesSessionAuthWhenComposedAfterAuthLoader(t *testing.T) {
	t.Parallel()

	sessionKey := "550e8400-e29b-41d4-a716-446655440000"
	token := "smithers_0123456789abcdef0123456789abcdef01234567"
	tokenHash := sha256.Sum256([]byte(token))

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			requireSessionLookupKey(t, sessionKey, key)
			return db.AuthSession{
				SessionKey: key,
				UserID:     7,
				Username:   "session-user",
				ExpiresAt:  time.Now().UTC().Add(time.Hour),
			}, nil
		},
		getAuthInfoByTokenHashFn: func(ctx context.Context, gotHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, hex.EncodeToString(tokenHash[:]), gotHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:            9,
				Username:      "token-user",
				LowerUsername: "token-user",
				IsActive:      true,
				TokenID:       44,
				TokenScopes:   "read:user",
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			switch id {
			case 7:
				return db.User{
					ID:            7,
					Username:      "session-user",
					LowerUsername: "session-user",
					IsActive:      true,
				}, nil
			default:
				return db.User{}, pgx.ErrNoRows
			}
		},
	}

	var gotInfo *AuthInfo
	handler := AuthLoader(q, config.AuthConfig{})(TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotInfo = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sse/ticket", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	req.Header.Set("Authorization", "token "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.NotNil(t, gotInfo)
	require.NotNil(t, gotInfo.User)
	assert.Equal(t, int64(9), gotInfo.User.ID)
	assert.Equal(t, "token-user", gotInfo.User.Username)
	assert.True(t, gotInfo.IsTokenAuth)
	assert.Equal(t, hex.EncodeToString(tokenHash[:]), gotInfo.TokenHash)
}

func TestAuthLoader_LoadsSessionCookie(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	sessionKey := "a6051465-b966-4b6b-94f1-7bc6fef9d17f"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			requireSessionLookupKey(t, sessionKey, key)
			return db.AuthSession{
				SessionKey: key,
				UserID:     44,
				Username:   "session-user",
				IsAdmin:    true,
				ExpiresAt:  now.Add(24 * time.Hour),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			require.Equal(t, int64(44), id)
			return db.User{
				ID:            44,
				Username:      "session-user",
				LowerUsername: "session-user",
				IsAdmin:       true,
				IsActive:      true,
			}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := UserFromContext(r.Context())
		require.NotNil(t, user)
		assert.Equal(t, int64(44), user.ID)
		assert.Equal(t, "session-user", user.Username)

		authInfo := AuthInfoFromContext(r.Context())
		require.NotNil(t, authInfo)
		assert.False(t, authInfo.IsTokenAuth)
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 1, q.getAuthSessionBySessionKeyHit)
	assert.Equal(t, 1, q.getUserByIDHit)
	assert.Equal(t, 0, q.getAuthInfoByTokenHashHit)
}

func TestAuthLoader_FallsBackToTokenAuth(t *testing.T) {
	t.Parallel()

	token := "smithers_0123456789abcdef0123456789abcdef01234567"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:            55,
				Username:      "token-user",
				LowerUsername: "token-user",
				IsActive:      true,
				TokenID:       901,
				TokenScopes:   "write:user",
			}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := UserFromContext(r.Context())
		require.NotNil(t, user)
		assert.Equal(t, int64(55), user.ID)

		authInfo := AuthInfoFromContext(r.Context())
		require.NotNil(t, authInfo)
		assert.True(t, authInfo.IsTokenAuth)
		assert.Equal(t, int64(901), authInfo.TokenID)
		assert.True(t, authInfo.Scopes.Has(ScopeWriteUser))
		assert.Equal(t, TokenSourcePersonalAccessToken, authInfo.TokenSource)
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 1, q.getAuthInfoByTokenHashHit)
	assert.Equal(t, 1, q.updateAccessTokenLastUsedHit)
}

func TestAuthLoader_FallsBackToOAuth2TokenAuth(t *testing.T) {
	t.Parallel()

	token := "smithers_oat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.Oauth2AccessToken{
				ID:     73,
				UserID: 91,
				Scopes: []string{"read:user"},
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			require.Equal(t, int64(91), id)
			return db.User{ID: id, Username: "oauth2-user", LowerUsername: "oauth2-user", IsActive: true}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authInfo := AuthInfoFromContext(r.Context())
		require.NotNil(t, authInfo)
		assert.Equal(t, TokenSourceOAuth2AccessToken, authInfo.TokenSource)
		assert.True(t, authInfo.Scopes.Has(ScopeReadUser))
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 1, q.getAuthInfoByTokenHashHit)
	assert.Equal(t, 1, q.getOAuth2AccessTokenByHashHit)
	assert.Equal(t, 0, q.updateAccessTokenLastUsedHit)
}

func TestAuthLoader_RefreshesSessionNearExpiry(t *testing.T) {
	t.Parallel()

	sessionKey := "8b2f8357-9165-4e72-b154-f1d871f420e6"
	expiresSoon := time.Now().UTC().Add(4 * 24 * time.Hour)
	cfg := config.AuthConfig{
		SessionDuration:      "720h",
		SessionRefreshWindow: "168h",
		SessionCookieName:    "smithers_session",
		CookieSecure:         true,
	}

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			// Emulate a legacy raw-keyed row (pre-hashing generation): the
			// digest lookup misses, the raw-key fallback hits.
			if key != sessionKey {
				return db.AuthSession{}, pgx.ErrNoRows
			}
			return db.AuthSession{
				SessionKey: key,
				UserID:     77,
				Username:   "refresh-user",
				ExpiresAt:  expiresSoon,
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "refresh-user", LowerUsername: "refresh-user", IsActive: true}, nil
		},
		refreshAuthSessionFn: func(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error) {
			require.Equal(t, sessionKey, arg.SessionKey)
			require.True(t, arg.ExpiresAt.After(expiresSoon))
			return db.AuthSession{
				SessionKey: sessionKey,
				UserID:     77,
				Username:   "refresh-user",
				ExpiresAt:  arg.ExpiresAt,
			}, nil
		},
	}

	handler := AuthLoader(q, cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 1, q.refreshAuthSessionHit)
	assert.Contains(t, rec.Header().Get("Set-Cookie"), "smithers_session="+sessionKey)
	// SECURITY: refreshed session cookie must have Secure attribute
	refreshedCookies := rec.Result().Cookies()
	// A refreshed session also re-mints the CSRF cookie in lockstep (#207) so
	// it never silently expires ahead of a still-valid, refreshed session.
	require.Len(t, refreshedCookies, 2)
	sessionCookie := cookieByNameInList(refreshedCookies, "smithers_session")
	require.NotNil(t, sessionCookie)
	assert.True(t, sessionCookie.Secure, "refreshed session cookie must have Secure attribute")
	csrfCookie := cookieByNameInList(refreshedCookies, CSRFCookieName)
	require.NotNil(t, csrfCookie)
	assert.True(t, csrfCookie.Secure)
	assert.Equal(t, sessionCookie.Expires, csrfCookie.Expires)
}

func cookieByNameInList(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// requireSessionLookupKey accepts either generation of auth_sessions storage
// key: the SHA-256 digest (sessions minted after keys were hashed at rest)
// or the legacy raw UUID (older rows, valid until they expire).
func requireSessionLookupKey(t *testing.T, rawSessionKey, lookupKey string) {
	t.Helper()
	require.Contains(t, []string{sessionStorageKey(rawSessionKey), rawSessionKey}, lookupKey)
}

func TestRequireAuth_AllowsAuthenticatedUser(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	// Inject authenticated user via context
	ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{
		User:        &db.User{ID: 1, Username: "alice"},
		IsTokenAuth: true,
	})
	req = req.WithContext(ctx)

	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, nextCalled)
}

func TestAuthLoader_SkipsExpiredSession(t *testing.T) {
	t.Parallel()

	sessionKey := "expired-session-key-uuid"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: key,
				UserID:     44,
				Username:   "expired-user",
				ExpiresAt:  time.Now().UTC().Add(-1 * time.Hour), // expired
			}, nil
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "expired session should not load user")
	assert.Equal(t, 1, q.getAuthSessionBySessionKeyHit)
	assert.Equal(t, 0, q.getUserByIDHit, "should not look up user for expired session")
}

func TestAuthLoader_SessionUserLookupFailure(t *testing.T) {
	t.Parallel()

	sessionKey := "valid-session-bad-user"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: key,
				UserID:     999,
				Username:   "ghost",
				ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
			}, nil
		},
		// getUserByIDFn uses default (pgx.ErrNoRows) - user not found
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "should not set user when user lookup fails")
}

func TestAuthLoader_CustomSessionCookieName(t *testing.T) {
	t.Parallel()

	sessionKey := "custom-cookie-session-key"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			requireSessionLookupKey(t, sessionKey, key)
			return db.AuthSession{
				SessionKey: key,
				UserID:     88,
				Username:   "custom-cookie-user",
				ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "custom-cookie-user", IsActive: true}, nil
		},
	}

	cfg := config.AuthConfig{SessionCookieName: "my_session"}

	var capturedUser *db.User
	handler := AuthLoader(q, cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "my_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.NotNil(t, capturedUser)
	assert.Equal(t, "custom-cookie-user", capturedUser.Username)
}

func TestAuthLoader_TokenPrioritizedOverSession(t *testing.T) {
	t.Parallel()

	sessionKey := "priority-session-key"
	token := "smithers_0123456789abcdef0123456789abcdef01234567"
	tokenHash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(tokenHash[:])

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			t.Fatal("session lookup should not run when a bearer token is present")
			return db.AuthSession{}, nil
		},
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:            22,
				Username:      "token-user",
				LowerUsername: "token-user",
				IsActive:      true,
				TokenID:       42,
				TokenScopes:   "read:user",
			}, nil
		},
	}

	var capturedAuth *AuthInfo
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.NotNil(t, capturedAuth)
	require.NotNil(t, capturedAuth.User)
	assert.True(t, capturedAuth.IsTokenAuth, "bearer auth should take priority over session auth")
	assert.Equal(t, "token-user", capturedAuth.User.Username)
	assert.Equal(t, 1, q.getAuthInfoByTokenHashHit)
	assert.Equal(t, 0, q.getAuthSessionBySessionKeyHit)
}

func TestAuthLoader_InvalidTokenDoesNotFallBackToSession(t *testing.T) {
	t.Parallel()

	sessionKey := "valid-session-key"
	token := "smithers_0123456789abcdef0123456789abcdef01234567"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			t.Fatal("session lookup should not run when an invalid bearer token is present")
			return db.AuthSession{}, nil
		},
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		},
	}

	var capturedAuth *AuthInfo
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = AuthInfoFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedAuth)
	assert.Equal(t, 1, q.getAuthInfoByTokenHashHit)
	assert.Equal(t, 1, q.getOAuth2AccessTokenByHashHit)
	assert.Equal(t, 0, q.getAuthSessionBySessionKeyHit)
}

func TestUserFromContext_NilContext(t *testing.T) {
	t.Parallel()

	user := UserFromContext(context.Background())
	assert.Nil(t, user)
}

func TestExtractToken_ThreePartAuthHeader(t *testing.T) {
	t.Parallel()

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer extra smithers_0123456789abcdef0123456789abcdef01234567")

	assert.Equal(t, "", ExtractToken(r))
}

func TestAuthLoader_SessionDBLookupFailureFallsThrough(t *testing.T) {
	t.Parallel()

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{}, assert.AnError // DB error
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "some-session-key"})
	handler.ServeHTTP(rec, req)

	// Should continue as anonymous when session lookup fails
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "user should be nil when session DB lookup fails")
	assert.Equal(t, 1, q.getAuthSessionBySessionKeyHit)
}

func TestAuthLoader_TokenDBLookupFailureContinuesAnonymous(t *testing.T) {
	t.Parallel()

	token := "smithers_cccccccccccccccccccccccccccccccccccccccc"

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, assert.AnError // DB error (not pgx.ErrNoRows)
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	// Should continue as anonymous when token DB lookup fails
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "user should be nil when token DB lookup fails")
	assert.Equal(t, 1, q.getAuthInfoByTokenHashHit)
}

func TestAuthLoader_SessionRefreshFailureSilentlyIgnored(t *testing.T) {
	t.Parallel()

	sessionKey := "refresh-fail-session-key"
	// Session expires in 4 days — within the 168h (7-day) refresh window
	expiresSoon := time.Now().UTC().Add(4 * 24 * time.Hour)

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: key,
				UserID:     99,
				Username:   "refresh-fail-user",
				ExpiresAt:  expiresSoon,
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "refresh-fail-user", IsActive: true}, nil
		},
		// refreshAuthSessionFn uses default — returns assert.AnError (failure)
	}

	cfg := config.AuthConfig{
		SessionDuration:      "720h",
		SessionRefreshWindow: "168h",
	}

	var capturedUser *db.User
	handler := AuthLoader(q, cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	// Request should succeed even though refresh failed
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.NotNil(t, capturedUser, "user should still be loaded even when refresh fails")
	assert.Equal(t, "refresh-fail-user", capturedUser.Username)
	// Refresh was attempted but failed
	assert.Equal(t, 1, q.refreshAuthSessionHit, "should have attempted refresh")
	// The session cookie itself is not re-set because refresh failed, but the
	// request still had no __csrf cookie, so the CSRF self-heal (#207) mints
	// one regardless of the refresh outcome.
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1, "only the self-healed csrf cookie should be set")
	assert.Equal(t, CSRFCookieName, cookies[0].Name)
	assert.Greater(t, cookies[0].MaxAge, 0)
}

func TestAuthLoader_TokenAuthUpdateLastUsedFailureSilentlyIgnored(t *testing.T) {
	t.Parallel()

	token := "smithers_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			require.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:          66,
				Username:    "last-used-fail-user",
				IsActive:    true,
				TokenID:     777,
				TokenScopes: "write:repository",
			}, nil
		},
		updateAccessTokenLastUsedFn: func(ctx context.Context, id int64) error {
			return assert.AnError // simulate failure
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	// Request should succeed even though UpdateAccessTokenLastUsed failed
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.NotNil(t, capturedUser, "user should still be loaded even when last-used update fails")
	assert.Equal(t, "last-used-fail-user", capturedUser.Username)
	assert.Equal(t, 1, q.updateAccessTokenLastUsedHit, "should have attempted update")
}

// --- prohibit_login enforcement tests ---

func TestTokenAuth_RejectsProhibitedLoginUser(t *testing.T) {
	t.Parallel()

	token := "smithers_0123456789abcdef0123456789abcdef01234567"

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            42,
				Username:      "banned-user",
				IsActive:      true,
				ProhibitLogin: true,
				TokenID:       1,
				TokenScopes:   "read:repository",
			}, nil
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called for prohibited-login user")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Equal(t, "account is suspended", apiErrorMessage(t, w))
}

func TestAuthLoader_SessionAuth_RejectsProhibitedLoginUser(t *testing.T) {
	t.Parallel()

	sessionKey := "a6051465-b966-4b6b-94f1-7bc6fef9d17f"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{
				SessionKey: key,
				UserID:     77,
				Username:   "banned-session-user",
				ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{
				ID:            77,
				Username:      "banned-session-user",
				LowerUsername: "banned-session-user",
				IsActive:      true,
				ProhibitLogin: true,
			}, nil
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "prohibited-login user should not be set in context via session auth")
}

func TestAuthLoader_TokenAuth_RejectsProhibitedLoginUser(t *testing.T) {
	t.Parallel()

	token := "smithers_0123456789abcdef0123456789abcdef01234567"

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            88,
				Username:      "banned-token-user",
				IsActive:      true,
				ProhibitLogin: true,
				TokenID:       2,
				TokenScopes:   "write:repository",
			}, nil
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Nil(t, capturedUser, "prohibited-login user should not be set in context via token auth")
}

// TestTokenAuth_ExpiredTokenRejected pins the expired-PAT contract: expiry is
// enforced in SQL by GetAuthInfoByTokenHash (db/queries/users.sql — the lookup
// includes `expires_at IS NULL OR expires_at > NOW()`), so an expired token's
// hash matches no row (pgx.ErrNoRows) and both middleware token paths must
// answer 401 rather than authenticating or 500ing. The mock reproduces the SQL
// contract for a token whose expires_at has passed.
func TestTokenAuth_ExpiredTokenRejected(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			// Expired rows are filtered out by the WHERE clause: no row.
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called for an expired token")
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Equal(t, "invalid or expired token", apiErrorMessage(t, w))
}

// --- CSRF cookie self-heal (#207) ---
//
// A persistent session cookie must never outlive the CSRF double-submit
// cookie: if the session is valid but the request carries no (or an empty)
// __csrf cookie, AuthLoader mints and sets a fresh one scoped to the same
// expiry as the session, so a returning user's mutating requests are never
// silently blocked by a missing CSRF cookie.

func TestAuthLoader_SelfHealsMissingCSRFCookie(t *testing.T) {
	t.Parallel()

	sessionKey := "csrf-self-heal-session"
	// Far outside the default 168h refresh window so no refresh is attempted;
	// this isolates the self-heal path from the refresh-reissue path.
	expiresAt := time.Now().UTC().Add(720 * time.Hour)

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: key, UserID: 12, Username: "csrf-user", ExpiresAt: expiresAt}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "csrf-user", IsActive: true}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{CookieSecure: true})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 0, q.refreshAuthSessionHit, "session is far from expiry; no refresh expected")

	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	csrfCookie := cookies[0]
	assert.Equal(t, CSRFCookieName, csrfCookie.Name)
	assert.NotEmpty(t, csrfCookie.Value)
	assert.Greater(t, csrfCookie.MaxAge, 0)
	assert.WithinDuration(t, expiresAt, csrfCookie.Expires, time.Second)
	assert.True(t, csrfCookie.Secure)
}

func TestAuthLoader_DoesNotReissueExistingCSRFCookie(t *testing.T) {
	t.Parallel()

	sessionKey := "csrf-present-session"
	expiresAt := time.Now().UTC().Add(720 * time.Hour)

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: key, UserID: 13, Username: "csrf-present-user", ExpiresAt: expiresAt}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "csrf-present-user", IsActive: true}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionKey})
	req.AddCookie(&http.Cookie{Name: CSRFCookieName, Value: "already-issued-token"})
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Empty(t, rec.Header().Get("Set-Cookie"), "an existing __csrf cookie must not be reissued")
}

func TestAuthLoader_BearerTokenRequestNeverGetsCSRFCookie(t *testing.T) {
	t.Parallel()

	token := "smithers_ddddddddddddddddddddddddddddddddddddddd"

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          21,
				Username:    "token-only-user",
				IsActive:    true,
				TokenID:     55,
				TokenScopes: "read:user",
			}, nil
		},
	}

	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/private", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Empty(t, rec.Header().Get("Set-Cookie"), "token-authenticated requests never get a __csrf cookie")
}

// Same contract through AuthLoader's token path: an expired PAT must not
// produce an authenticated context (and must not fall back to session auth).
func TestAuthLoader_ExpiredTokenYieldsAnonymous(t *testing.T) {
	t.Parallel()

	q := &mockAuthLoaderQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, pgx.ErrNoRows
		},
	}

	var capturedUser *db.User
	handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Nil(t, capturedUser, "expired token must not authenticate")
}
