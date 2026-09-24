package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type cliAdminAuthFake struct {
	mockAuthService
	start   func(context.Context, string, string, int, string, string) (string, error)
	prepare func(context.Context, services.OAuthCallbackResult, string, string) (services.AdminCLIConsent, error)
	approve func(context.Context, string, string, string, string) (services.AdminCLILoginResult, error)
}

func (f cliAdminAuthFake) StartAdminCLILogin(c context.Context, v, ttl string, p int, state, scopes string) (string, error) {
	return f.start(c, v, ttl, p, state, scopes)
}
func (f cliAdminAuthFake) PrepareAdminCLIConsent(c context.Context, r services.OAuthCallbackResult, s, v string) (services.AdminCLIConsent, error) {
	return f.prepare(c, r, s, v)
}
func (f cliAdminAuthFake) ApproveAdminCLILogin(c context.Context, s, v, csrf, ip string) (services.AdminCLILoginResult, error) {
	return f.approve(c, s, v, csrf, ip)
}

func TestAdminCLIStartHandler(t *testing.T) {
	for _, tc := range []struct {
		query  string
		status int
	}{
		{"admin=1", 302}, {"admin=1&ttl=5m", 302}, {"admin=1&ttl=12h", 302}, {"admin=1&ttl=4m59s", 400}, {"admin=1&ttl=12h1s", 400}, {"admin=1&ttl=bad", 400}, {"admin=2", 400}, {"ttl=1h", 400}, {"scopes=read:admin", 422}, {"admin=1&scopes=read:admin", 422},
	} {
		t.Run(tc.query, func(t *testing.T) {
			f := cliAdminAuthFake{start: func(_ context.Context, verifier, ttl string, port int, state, scopes string) (string, error) {
				require.NotEmpty(t, verifier)
				require.Equal(t, 4321, port)
				if _, err := services.ParseAdminCLITTL(ttl); err != nil {
					return "", err
				}
				if scopes == "read:admin" {
					return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Field: "scopes", Code: "invalid"})
				}
				return "https://github.com/login/oauth/authorize?state=bound", nil
			}}
			f.startGitHubScopesFn = func(_ context.Context, verifier, scopes string) (string, error) {
				require.Equal(t, "read:admin", scopes)
				return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Field: "scopes", Code: "invalid"})
			}
			h := AuthHandler{Service: f}
			w := httptest.NewRecorder()
			h.GetGitHubOAuthCLIStart(w, httptest.NewRequest("GET", "/api/auth/github/cli?callback_port=4321&"+tc.query, nil))
			require.Equal(t, tc.status, w.Code)
			if tc.status == 302 {
				require.Contains(t, w.Header().Get("Location"), "github.com")
				require.Len(t, w.Result().Cookies(), 2)
			}
		})
	}
}

func TestAdminCLICallbackRequiresConsent(t *testing.T) {
	for _, admin := range []bool{false, true} {
		t.Run(fmt.Sprint(admin), func(t *testing.T) {
			minted := 0
			f := cliAdminAuthFake{}
			f.completeGitHubFn = func(_ context.Context, code, state, verifier string) (services.OAuthCallbackResult, error) {
				require.Equal(t, "state", state)
				require.Equal(t, "verifier", verifier)
				return services.OAuthCallbackResult{User: db.User{ID: 7, IsAdmin: admin}, AdminCLI: &services.AdminCLIRequest{TTL: time.Hour, CallbackPort: 4321}}, nil
			}
			f.createTokenFn = func(context.Context, int64, services.CreateTokenRequest) (services.CreateTokenResult, error) {
				minted++
				return services.CreateTokenResult{}, nil
			}
			f.prepare = func(_ context.Context, result services.OAuthCallbackResult, state, verifier string) (services.AdminCLIConsent, error) {
				if !result.User.IsAdmin {
					return services.AdminCLIConsent{}, pkgerrors.Forbidden("administrator access required")
				}
				return services.AdminCLIConsent{State: "consent-state", CSRF: "csrf-value", Scopes: []string{"write:user", "read:admin", "write:admin"}, TTL: "1h0m0s", CallbackPort: 4321, ExpiresAt: time.Date(2026, 9, 13, 13, 0, 0, 0, time.UTC)}, nil
			}
			r := httptest.NewRequest("GET", "/api/auth/github/callback?code=code&state=state", nil)
			r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "verifier"})
			r.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "4321:verifier"})
			w := httptest.NewRecorder()
			h := AuthHandler{Service: f}
			h.GetGitHubOAuthCallback(w, r)
			require.Zero(t, minted)
			require.Empty(t, w.Header().Get("Location"))
			require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
			if !admin {
				require.Equal(t, 403, w.Code)
				require.Contains(t, w.Body.String(), "No CLI token was created")
				return
			}
			require.Equal(t, 200, w.Code)
			for _, expected := range []string{"read:admin", "write:admin", "1h0m0s", "4321", "2026-09-13T13:00:00Z", `method="post"`, `name="state" value="consent-state"`, `name="csrf_token" value="csrf-value"`, ">Deny</a>"} {
				require.Contains(t, w.Body.String(), expected)
			}
		})
	}
}

func TestAdminCLIConsentPost(t *testing.T) {
	expiry := time.Date(2026, 9, 13, 13, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, state, csrf, verifier, decision string
		status                                int
	}{
		{"approved", "state", "csrf", "verifier", "approve", 302}, {"csrf-missing", "state", "", "verifier", "approve", 403}, {"verifier-missing", "state", "csrf", "", "approve", 403}, {"state-wrong", "wrong", "csrf", "verifier", "approve", 403}, {"no-decision", "state", "csrf", "verifier", "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			f := cliAdminAuthFake{approve: func(_ context.Context, state, verifier, csrf, ip string) (services.AdminCLILoginResult, error) {
				calls++
				require.Equal(t, "192.0.2.1:1234", ip)
				if state != "state" || verifier != "verifier" || csrf != "csrf" {
					return services.AdminCLILoginResult{}, pkgerrors.Forbidden("invalid consent")
				}
				return services.AdminCLILoginResult{User: db.User{Username: "alice"}, Request: services.AdminCLIRequest{CallbackPort: 4321, CallbackState: strings.Repeat("a", 43)}, Token: services.CreateTokenResult{Token: "smithers_admin", TokenSummary: services.TokenSummary{ExpiresAt: &expiry}}}, nil
			}}
			form := url.Values{"state": {tc.state}, "csrf_token": {tc.csrf}, "decision": {tc.decision}}
			r := httptest.NewRequest("POST", "/api/auth/github/cli/consent", strings.NewReader(form.Encode()))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: tc.verifier})
			w := httptest.NewRecorder()
			h := AuthHandler{Service: f}
			h.PostAdminCLIConsent(w, r)
			require.Equal(t, tc.status, w.Code)
			if tc.status == 302 {
				target, err := url.Parse(w.Header().Get("Location"))
				require.NoError(t, err)
				require.Equal(t, "127.0.0.1:4321", target.Host)
				require.Empty(t, target.RawQuery)
				fragment, err := url.ParseQuery(target.Fragment)
				require.NoError(t, err)
				require.Equal(t, "smithers_admin", fragment.Get("token"))
				require.Equal(t, expiry.Format(time.RFC3339), fragment.Get("expires_at"))
				require.Equal(t, strings.Repeat("a", 43), fragment.Get("callback_state"))
				require.Len(t, w.Result().Cookies(), 2)
			} else {
				require.Empty(t, w.Header().Get("Location"))
			}
			if tc.decision == "" {
				require.Zero(t, calls)
			}
		})
	}
}

func TestAdminCLIDenyAndMalformedForm(t *testing.T) {
	h := AuthHandler{}
	w := httptest.NewRecorder()
	h.GetAdminCLIConsent(w, httptest.NewRequest("GET", "/api/auth/github/cli/consent", nil))
	require.Equal(t, 200, w.Code)
	require.Len(t, w.Result().Cookies(), 2)
	require.Contains(t, w.Body.String(), "No token was created")
	r := httptest.NewRequest("POST", "/api/auth/github/cli/consent", strings.NewReader("state=%zz"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w = httptest.NewRecorder()
	h.PostAdminCLIConsent(w, r)
	require.Equal(t, 400, w.Code)
	r = httptest.NewRequest("POST", "/api/auth/github/cli/consent?decision=approve&state=state&csrf_token=csrf", nil)
	w = httptest.NewRecorder()
	h.PostAdminCLIConsent(w, r)
	require.Equal(t, 400, w.Code, "query values cannot approve a consent form")
}

func TestAdminCLIStartAndConsentSecureVerifier(t *testing.T) {
	var verifier string
	callbackState := strings.Repeat("A", 43)
	f := cliAdminAuthFake{
		start: func(_ context.Context, v, ttl string, port int, state, scopes string) (string, error) {
			verifier = v
			require.Equal(t, callbackState, state)
			return "https://github.com/login/oauth/authorize?state=bound", nil
		},
		prepare: func(_ context.Context, _ services.OAuthCallbackResult, _, v string) (services.AdminCLIConsent, error) {
			require.Equal(t, verifier, v)
			return services.AdminCLIConsent{State: "consent", CSRF: "csrf"}, nil
		},
	}
	f.completeGitHubFn = func(_ context.Context, _, _, v string) (services.OAuthCallbackResult, error) {
		require.Equal(t, verifier, v)
		return services.OAuthCallbackResult{User: db.User{ID: 7, IsAdmin: true}, AdminCLI: &services.AdminCLIRequest{CallbackPort: 4321, CallbackState: callbackState}}, nil
	}
	h := AuthHandler{Service: f}
	h.AuthConfig.CookieSecure = true
	start := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/auth/github/cli?callback_port=4321&admin=1&callback_state="+callbackState, nil)
	r.AddCookie(&http.Cookie{Name: cliCallbackCookieName, Value: "4321:stale"})
	h.GetGitHubOAuthCLIStart(start, r)
	require.Equal(t, http.StatusFound, start.Code)

	consent := httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/auth/github/callback?code=code&state=bound", nil)
	r.AddCookie(cookieByName(start.Result().Cookies(), oauthStateCookieName))
	// A stale legacy cookie must not be needed for the durable admin flow.
	h.GetGitHubOAuthCallback(consent, r)
	require.Equal(t, http.StatusOK, consent.Code)
	for _, response := range []*httptest.ResponseRecorder{start, consent} {
		cookies := response.Result().Cookies()
		stateCookie := cookieByName(cookies, oauthStateCookieName)
		require.NotNil(t, stateCookie)
		require.Equal(t, verifier, stateCookie.Value)
		require.True(t, stateCookie.Secure)
		legacy := cookieByName(cookies, cliCallbackCookieName)
		require.NotNil(t, legacy)
		require.Empty(t, legacy.Value)
		require.Equal(t, -1, legacy.MaxAge)
		for _, cookie := range cookies {
			if strings.Contains(cookie.Value, verifier) {
				require.True(t, cookie.Secure, "verifier leaked via %s", cookie.Name)
			}
		}
	}
}
