package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

func sha256HexString(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func TestAuthLoader_StoredDigestIsNotABearerCredential(t *testing.T) {
	storedKey := sha256HexString("a6051465-b966-4b6b-94f1-7bc6fef9d17f")
	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(_ context.Context, key string) (db.AuthSession, error) {
			if key != storedKey {
				return db.AuthSession{}, pgx.ErrNoRows
			}
			return db.AuthSession{SessionKey: storedKey, UserID: 44, ExpiresAt: time.Now().Add(24 * time.Hour)}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 44, IsActive: true}, nil
		},
	}
	info, _ := loadSessionAuth(context.Background(), q, storedKey, time.Now())
	require.Nil(t, info, "a database dump must not authenticate through the legacy fallback")
}

// The session cookie value is a live bearer credential, so auth_sessions rows
// minted after keys were hashed at rest are filed under the key's SHA-256
// digest. The loader must resolve a session whose row is keyed by that digest.
func TestAuthLoader_LoadsSessionStoredAsHash(t *testing.T) {
	t.Parallel()

	sessionKey := "a6051465-b966-4b6b-94f1-7bc6fef9d17f"
	storedKey := sha256HexString(sessionKey)

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			if key != storedKey {
				return db.AuthSession{}, pgx.ErrNoRows
			}
			return db.AuthSession{
				SessionKey: storedKey,
				UserID:     44,
				Username:   "session-user",
				ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "session-user", LowerUsername: "session-user", IsActive: true}, nil
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
	require.NotNil(t, capturedUser, "a session stored under the key digest must authenticate")
	assert.Equal(t, int64(44), capturedUser.ID)
}

// Rows minted before keys were hashed at rest are still keyed by the raw UUID
// until they expire; the loader must keep resolving them so the change does
// not force a global logout on deploy.
func TestAuthLoader_LegacyRawStoredSessionStillLoads(t *testing.T) {
	t.Parallel()

	sessionKey := "550e8400-e29b-41d4-a716-446655440000"

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			if key != sessionKey {
				return db.AuthSession{}, pgx.ErrNoRows
			}
			return db.AuthSession{
				SessionKey: sessionKey,
				UserID:     7,
				Username:   "legacy-user",
				ExpiresAt:  time.Now().UTC().Add(24 * time.Hour),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "legacy-user", LowerUsername: "legacy-user", IsActive: true}, nil
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
	require.NotNil(t, capturedUser, "a legacy raw-keyed session must keep authenticating until it expires")
	assert.Equal(t, int64(7), capturedUser.ID)
}

// When a hash-stored session is refreshed, the re-set session cookie must
// carry the RAW key the client presented — never the stored digest, which
// would silently log the user out on the next request.
func TestAuthLoader_RefreshKeepsRawSessionCookieValue(t *testing.T) {
	t.Parallel()

	sessionKey := "8b2f8357-9165-4e72-b154-f1d871f420e6"
	storedKey := sha256HexString(sessionKey)
	expiresSoon := time.Now().UTC().Add(4 * 24 * time.Hour)
	cfg := config.AuthConfig{
		SessionDuration:      "720h",
		SessionRefreshWindow: "168h",
		SessionCookieName:    "smithers_session",
		CookieSecure:         true,
	}

	q := &mockAuthLoaderQuerier{
		getAuthSessionBySessionKeyFn: func(ctx context.Context, key string) (db.AuthSession, error) {
			if key != storedKey {
				return db.AuthSession{}, pgx.ErrNoRows
			}
			return db.AuthSession{
				SessionKey: storedKey,
				UserID:     77,
				Username:   "refresh-user",
				ExpiresAt:  expiresSoon,
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "refresh-user", LowerUsername: "refresh-user", IsActive: true}, nil
		},
		refreshAuthSessionFn: func(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error) {
			require.Equal(t, storedKey, arg.SessionKey, "refresh must key off the stored digest")
			return db.AuthSession{
				SessionKey: storedKey,
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
	sessionCookie := cookieByNameInList(rec.Result().Cookies(), "smithers_session")
	require.NotNil(t, sessionCookie, "refresh must re-set the session cookie")
	assert.Equal(t, sessionKey, sessionCookie.Value,
		"the refreshed cookie must carry the raw session key, not the stored digest")
}
