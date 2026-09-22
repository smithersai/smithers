package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type localIdentityRouteService struct {
	bootstrap           services.LocalBootstrapRequest
	loginFn             func(string, string) (services.LocalLoginResult, error)
	passwordChangeCalls int
}

func (s *localIdentityRouteService) LocalIdentityStatus(context.Context) (services.LocalIdentityStatus, error) {
	return services.LocalIdentityStatus{Enabled: true, Initialized: true}, nil
}

func (s *localIdentityRouteService) BootstrapLocalOwner(_ context.Context, req services.LocalBootstrapRequest) (services.LocalLoginResult, error) {
	s.bootstrap = req
	return localRouteLoginResult(), nil
}

func (s *localIdentityRouteService) LoginLocalOwner(_ context.Context, username, password string) (services.LocalLoginResult, error) {
	if s.loginFn != nil {
		return s.loginFn(username, password)
	}
	return localRouteLoginResult(), nil
}

func (s *localIdentityRouteService) CreateLocalOwnerToken(context.Context, string, string, string, []string) (services.CreateTokenResult, db.User, error) {
	return services.CreateTokenResult{TokenSummary: services.TokenSummary{ID: 4, Name: "cli"}, Token: "smithers_secret"}, localRouteLoginResult().User, nil
}

func (s *localIdentityRouteService) ChangeLocalOwnerPassword(context.Context, int64, string, string) (services.LocalLoginResult, error) {
	s.passwordChangeCalls++
	return localRouteLoginResult(), nil
}

func localRouteLoginResult() services.LocalLoginResult {
	return services.LocalLoginResult{
		User:       db.User{ID: 7, Username: "owner", IsAdmin: true, IsActive: true},
		SessionKey: "550e8400-e29b-41d4-a716-446655440000",
		ExpiresAt:  time.Now().Add(time.Hour),
	}
}

func TestAuthHandlerLocalBootstrapUsesHeaderSecretAndSetsWebSession(t *testing.T) {
	service := &localIdentityRouteService{}
	h := AuthHandler{LocalService: service, AuthConfig: defaultRouteAuthConfig(), AllowedOrigins: []string{"https://smithers.example"}}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/local/bootstrap", strings.NewReader(`{"username":"owner","email":"owner@example.test","password":"strong password"}`))
	req.Header.Set("Origin", "https://smithers.example")
	req.Header.Set("X-Smithers-Bootstrap-Token", "operator-secret")
	rec := httptest.NewRecorder()

	h.PostLocalBootstrap(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "operator-secret", service.bootstrap.BootstrapToken)
	assert.Equal(t, "owner", service.bootstrap.Username)
	assert.NotEmpty(t, cookieByName(rec.Result().Cookies(), "smithers_session").Value)
	assert.NotEmpty(t, cookieByName(rec.Result().Cookies(), "__csrf").Value)
}

func TestAuthHandlerLocalLoginRejectsCrossSiteBeforeCheckingPassword(t *testing.T) {
	called := false
	service := &localIdentityRouteService{loginFn: func(string, string) (services.LocalLoginResult, error) {
		called = true
		return localRouteLoginResult(), nil
	}}
	h := AuthHandler{LocalService: service, AllowedOrigins: []string{"https://smithers.example"}}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/local/login", strings.NewReader(`{"username":"owner","password":"strong password"}`))
	req.Header.Set("Origin", "https://attacker.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()

	h.PostLocalLogin(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.False(t, called)
}

func TestAuthHandlerLocalTokenDoesNotSetBrowserCookies(t *testing.T) {
	h := AuthHandler{LocalService: &localIdentityRouteService{}, AllowedOrigins: []string{"http://localhost:4000", "tauri://localhost"}}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/local/token", strings.NewReader(`{"username":"owner","password":"strong password"}`))
	rec := httptest.NewRecorder()

	h.PostLocalToken(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Result().Cookies())
	assert.Contains(t, rec.Body.String(), "smithers_secret")
}

func TestAuthHandlerLocalTokenAcceptsConfiguredWebviewOriginOnly(t *testing.T) {
	h := AuthHandler{LocalService: &localIdentityRouteService{}, AllowedOrigins: []string{"tauri://localhost"}}

	allowed := httptest.NewRequest(http.MethodPost, "/api/auth/local/token", strings.NewReader(`{"username":"owner","password":"strong password"}`))
	allowed.Header.Set("Origin", "tauri://localhost")
	allowedRec := httptest.NewRecorder()
	h.PostLocalToken(allowedRec, allowed)
	require.Equal(t, http.StatusOK, allowedRec.Code)

	denied := httptest.NewRequest(http.MethodPost, "/api/auth/local/token", strings.NewReader(`{"username":"owner","password":"strong password"}`))
	denied.Header.Set("Origin", "app://untrusted")
	deniedRec := httptest.NewRecorder()
	h.PostLocalToken(deniedRec, denied)
	assert.Equal(t, http.StatusForbidden, deniedRec.Code)
}

func TestAuthHandlerLocalOriginsDoNotConflateLoopbackAliases(t *testing.T) {
	h := AuthHandler{LocalService: &localIdentityRouteService{}, AllowedOrigins: []string{"http://localhost:4000"}}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/local/token", strings.NewReader(`{"username":"owner","password":"strong password"}`))
	req.Header.Set("Origin", "http://127.0.0.1:4000")
	rec := httptest.NewRecorder()

	h.PostLocalToken(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestAuthHandlerLocalStatusDoesNotRevealOwnerUsername(t *testing.T) {
	h := AuthHandler{LocalService: &localIdentityRouteService{}}
	rec := httptest.NewRecorder()

	h.GetLocalIdentityStatus(rec, httptest.NewRequest(http.MethodGet, "/api/auth/local/status", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"enabled":true,"initialized":true}`, rec.Body.String())
}

func TestAuthHandlerLocalPasswordRequiresBrowserSession(t *testing.T) {
	service := &localIdentityRouteService{}
	h := AuthHandler{LocalService: service}
	authInfo := &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "owner"},
		IsTokenAuth: true,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/auth/local/password", strings.NewReader(`{"current_password":"old strong password","new_password":"new strong password"}`))
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), authInfo))
	rec := httptest.NewRecorder()

	h.PostLocalPassword(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Zero(t, service.passwordChangeCalls)
}
