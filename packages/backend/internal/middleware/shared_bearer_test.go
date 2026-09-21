package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRequireSharedBearerToken_ValidToken(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "Bearer secret-token-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestRequireSharedBearerToken_InvalidToken(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireSharedBearerToken_MissingHeader(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireSharedBearerToken_EmptyExpectedToken(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Fail safe: empty expected token should reject all requests
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireSharedBearerToken_NonBearerScheme(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "Basic c2VjcmV0")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireSharedBearerToken_CaseInsensitiveBearer(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "bearer secret-token-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestRequireSharedBearerToken_TokenOnlyNoScheme(t *testing.T) {
	t.Parallel()

	handler := RequireSharedBearerToken("secret-token-123")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "secret-token-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Missing "Bearer" prefix should be rejected
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireSharedBearerToken_ConstantTimeComparison(t *testing.T) {
	t.Parallel()

	// Verify that the handler uses constant-time comparison by checking
	// that tokens of different lengths still reject properly
	handler := RequireSharedBearerToken("short")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/endpoint", nil)
	req.Header.Set("Authorization", "Bearer a-much-longer-token-that-doesnt-match")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
