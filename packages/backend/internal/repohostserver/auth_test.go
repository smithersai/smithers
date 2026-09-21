package repohostserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthMiddleware(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name       string
		path       string
		authHeader string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "missing_authorization_header_returns_401",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
			wantBody:   "authorization header is required",
		},
		{
			name:       "invalid_bearer_token_returns_401",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "Bearer wrong-token",
			wantStatus: http.StatusUnauthorized,
			wantBody:   "invalid bearer token",
		},
		{
			name:       "malformed_auth_header_without_bearer_prefix_returns_401",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "Token some-token",
			wantStatus: http.StatusUnauthorized,
			wantBody:   "bearer token is required",
		},
		{
			name:       "auth_header_with_only_scheme_returns_401",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "Bearer",
			wantStatus: http.StatusUnauthorized,
			wantBody:   "bearer token is required",
		},
		{
			name:       "valid_bearer_token_passes_through",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "Bearer " + testAuthToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "health_endpoint_requires_no_auth",
			path:       "/health",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "metrics_endpoint_requires_no_auth",
			path:       "/metrics",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "protected_route_changes_without_auth_returns_401",
			path:       "/repos/testowner%3Atestrepo/changes",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "bearer_token_comparison_is_case_insensitive_for_scheme",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "bearer " + testAuthToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "bearer_token_comparison_is_exact_for_value",
			path:       "/repos/testowner%3Atestrepo/bookmarks",
			authHeader: "Bearer " + testAuthToken + "-extra",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			method := http.MethodGet
			req := httptest.NewRequest(method, tt.path, nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d; body=%s", tt.wantStatus, w.Code, w.Body.String())
			}

			if tt.wantBody != "" {
				var envelope errorEnvelope
				if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
					t.Fatalf("unmarshal error body: %v; raw=%s", err, w.Body.String())
				}
				if envelope.Message != tt.wantBody {
					t.Fatalf("expected message %q, got %q", tt.wantBody, envelope.Message)
				}
			}
		})
	}
}

func TestAuthMiddlewareErrorResponseShape(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name       string
		authHeader string
	}{
		{name: "missing_auth", authHeader: ""},
		{name: "invalid_token", authHeader: "Bearer bad"},
		{name: "malformed_scheme", authHeader: "Basic creds"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/repos/testowner%3Atestrepo/changes", nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d", w.Code)
			}

			var envelope map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("expected JSON error body, got: %s", w.Body.String())
			}

			if _, ok := envelope["message"]; !ok {
				t.Fatalf("error response missing 'message' field: %v", envelope)
			}
		})
	}
}
