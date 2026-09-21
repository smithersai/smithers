package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// csrfTestHandler is a simple handler that returns 200 OK for testing.
func csrfTestHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// setupCSRFRouter creates a router with CSRF middleware and auth context injection.
func setupCSRFRouter() *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.CSRF)
	r.Get("/test", csrfTestHandler)
	r.Post("/test", csrfTestHandler)
	r.Put("/test", csrfTestHandler)
	r.Patch("/test", csrfTestHandler)
	r.Delete("/test", csrfTestHandler)
	r.Head("/test", csrfTestHandler)
	r.Options("/test", csrfTestHandler)
	return r
}

// withAuthInfo adds AuthInfo to the request context (simulates AuthLoader running before CSRF).
func withAuthInfo(r *http.Request, isTokenAuth bool, user *db.User) *http.Request {
	authInfo := &middleware.AuthInfo{
		IsTokenAuth: isTokenAuth,
		User:        user,
	}
	ctx := middleware.ContextWithAuthInfo(r.Context(), authInfo)
	return r.WithContext(ctx)
}

func TestCSRF_SafeMethods_PassWithoutToken(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"GET", http.MethodGet},
		{"HEAD", http.MethodHead},
		{"OPTIONS", http.MethodOptions},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			// Create request with session auth but no CSRF token
			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

func TestCSRF_TokenAuth_BypassesCSRF(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			// Token-authenticated request without CSRF token should pass
			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, true, &db.User{ID: 1, Username: "alice"})

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

func TestCSRF_Anonymous_BypassesCSRF(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			// Anonymous request without CSRF token should pass
			req := httptest.NewRequest(tc.method, "/test", nil)
			// No AuthInfo in context - simulates unauthenticated request

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

func TestCSRF_SessionAuth_MissingToken_Returns403(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			// Session-authenticated request without CSRF header should fail.
			// Include the CSRF cookie to isolate missing-header behavior.
			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

			var body struct {
				Message string `json:"message"`
			}
			require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
			assert.Equal(t, "csrf token missing", body.Message)
		})
	}
}

func TestCSRF_SessionAuth_MissingCookie_Returns403(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})
			req.Header.Set("X-CSRF-Token", "valid-csrf-token")

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

			var body struct {
				Message string `json:"message"`
			}
			require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
			assert.Equal(t, "csrf token mismatch", body.Message)
		})
	}
}

func TestCSRF_SessionAuth_MismatchedToken_Returns403(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "cookie-token"})
			req.Header.Set("X-CSRF-Token", "header-token")

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

			var body struct {
				Message string `json:"message"`
			}
			require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
			assert.Equal(t, "csrf token mismatch", body.Message)
		})
	}
}

func TestCSRF_SessionAuth_EmptyCookieAndHeader_Returns403(t *testing.T) {
	t.Parallel()

	r := setupCSRFRouter()

	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: ""})
	req.Header.Set("X-CSRF-Token", "")

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
	assert.Equal(t, "csrf token missing", body.Message)
}

func TestCSRF_SessionAuth_WithMatchingCookieAndToken_Passes(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		method string
	}{
		{"POST", http.MethodPost},
		{"PUT", http.MethodPut},
		{"PATCH", http.MethodPatch},
		{"DELETE", http.MethodDelete},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := setupCSRFRouter()

			// Session-authenticated request with matching cookie/header token should pass.
			req := httptest.NewRequest(tc.method, "/test", nil)
			req = withAuthInfo(req, false, &db.User{ID: 1, Username: "alice"})
			req.Header.Set("X-CSRF-Token", "valid-csrf-token")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

func TestCSRF_AuthInfoWithNilUser_BypassesCSRF(t *testing.T) {
	t.Parallel()

	r := setupCSRFRouter()

	// AuthInfo exists but User is nil - should be treated as anonymous
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	authInfo := &middleware.AuthInfo{
		IsTokenAuth: false,
		User:        nil,
	}
	ctx := middleware.ContextWithAuthInfo(req.Context(), authInfo)
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestCSRF_MiddlewarePosition_AfterAuthLoader(t *testing.T) {
	t.Parallel()

	// This test verifies CSRF can access AuthInfo from context
	// simulating the actual middleware stack order

	var capturedIsTokenAuth bool
	var capturedHasUser bool

	r := chi.NewRouter()
	// Simulate AuthLoader setting context
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authInfo := &middleware.AuthInfo{
				IsTokenAuth: false,
				User:        &db.User{ID: 1, Username: "alice"},
			}
			ctx := middleware.ContextWithAuthInfo(r.Context(), authInfo)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Use(middleware.CSRF)
	r.Post("/test", func(w http.ResponseWriter, r *http.Request) {
		authInfo := middleware.AuthInfoFromContext(r.Context())
		if authInfo != nil {
			capturedIsTokenAuth = authInfo.IsTokenAuth
			capturedHasUser = authInfo.User != nil
		}
		w.WriteHeader(http.StatusOK)
	})

	// Request with CSRF token
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	req.Header.Set("X-CSRF-Token", "some-token")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "some-token"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.False(t, capturedIsTokenAuth, "should be session auth")
	assert.True(t, capturedHasUser, "should have user")
}

// TestCSRF_IntegrationWithRealRouter verifies CSRF works in a realistic router setup.
func TestCSRF_IntegrationWithRealRouter(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()

	// Simulate the actual middleware stack
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Simulate AuthLoader - sets auth info based on some condition
			var authInfo *middleware.AuthInfo
			if r.Header.Get("X-Simulate-Auth") == "token" {
				authInfo = &middleware.AuthInfo{
					IsTokenAuth: true,
					User:        &db.User{ID: 1, Username: "alice"},
				}
			} else if r.Header.Get("X-Simulate-Auth") == "session" {
				authInfo = &middleware.AuthInfo{
					IsTokenAuth: false,
					User:        &db.User{ID: 1, Username: "alice"},
				}
			}
			if authInfo != nil {
				ctx := middleware.ContextWithAuthInfo(r.Context(), authInfo)
				r = r.WithContext(ctx)
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(middleware.CSRF)

	r.Post("/api/resource", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"created":true}`))
	})

	// Test cases
	testCases := []struct {
		name           string
		authType       string
		csrfCookie     string
		csrfToken      string
		expectedStatus int
	}{
		{"token auth without csrf", "token", "", "", http.StatusCreated},
		{"token auth with csrf", "token", "token", "token", http.StatusCreated},
		{"session auth without csrf", "session", "", "", http.StatusForbidden},
		{"session auth missing cookie", "session", "", "valid-token", http.StatusForbidden},
		{"session auth mismatched cookie/header", "session", "cookie-token", "header-token", http.StatusForbidden},
		{"session auth with csrf", "session", "valid-token", "valid-token", http.StatusCreated},
		{"anonymous without csrf", "", "", "", http.StatusCreated},
		{"anonymous with csrf", "", "token", "token", http.StatusCreated},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodPost, "/api/resource", nil)
			if tc.authType != "" {
				req.Header.Set("X-Simulate-Auth", tc.authType)
			}
			if tc.csrfCookie != "" {
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: tc.csrfCookie})
			}
			if tc.csrfToken != "" {
				req.Header.Set("X-CSRF-Token", tc.csrfToken)
			}

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
		})
	}
}
