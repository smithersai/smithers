package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// auth0CoverRewriteRT rewrites scheme+host of every request to a test server,
// preserving the path so Auth0's hard-coded https URLs can be exercised.
type auth0CoverRewriteRT struct {
	base *url.URL
}

func (rt auth0CoverRewriteRT) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = rt.base.Scheme
	req.URL.Host = rt.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

type auth0CoverErrRT struct {
	err error
}

func (rt auth0CoverErrRT) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, rt.err
}

func auth0CoverClient(t *testing.T, h http.HandlerFunc) *Auth0Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base, err := url.Parse(srv.URL)
	require.NoError(t, err)

	c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
	c.httpClient = &http.Client{Transport: auth0CoverRewriteRT{base: base}}
	return c
}

func auth0CoverErrClient() *Auth0Client {
	c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
	c.httpClient = &http.Client{Transport: auth0CoverErrRT{err: errors.New("boom transport")}}
	return c
}

func TestAuth0_Cover_NewAuth0Client(t *testing.T) {
	t.Parallel()

	t.Run("uses provided connection and github base url", func(t *testing.T) {
		t.Parallel()

		c := NewAuth0Client("  tenant.auth0.com  ", "  cid  ", "  secret  ", "  https://app.example/callback  ", "  google-oauth2  ", "  https://ghe.example  ")
		assert.Equal(t, "tenant.auth0.com", c.domain)
		assert.Equal(t, "cid", c.clientID)
		assert.Equal(t, "secret", c.clientSecret)
		assert.Equal(t, "https://app.example/callback", c.redirectURI)
		assert.Equal(t, "google-oauth2", c.connection)
		assert.Equal(t, "https://ghe.example", c.githubAPIBaseURL)
		require.NotNil(t, c.httpClient)
		assert.Equal(t, 10*time.Second, c.httpClient.Timeout)
	})

	t.Run("defaults connection and github base url when empty", func(t *testing.T) {
		t.Parallel()

		c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "   ", "")
		assert.Equal(t, "github", c.connection)
		assert.Equal(t, "https://api.github.com", c.githubAPIBaseURL)
	})
}

func TestAuth0_Cover_AuthorizationURL(t *testing.T) {
	t.Parallel()

	c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
	raw := c.AuthorizationURL("state-123")
	parsed, err := url.Parse(raw)
	require.NoError(t, err)

	assert.Equal(t, "https", parsed.Scheme)
	assert.Equal(t, "tenant.auth0.com", parsed.Host)
	assert.Equal(t, "/authorize", parsed.Path)
	q := parsed.Query()
	assert.Equal(t, "code", q.Get("response_type"))
	assert.Equal(t, "cid", q.Get("client_id"))
	assert.Equal(t, "https://app.example/callback", q.Get("redirect_uri"))
	assert.Equal(t, "state-123", q.Get("state"))
	assert.Equal(t, "github", q.Get("connection"))
	assert.Equal(t, "openid profile email", q.Get("scope"))
}

func TestAuth0_Cover_ExchangeCode(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/oauth/token", r.URL.Path)
			require.Equal(t, "application/x-www-form-urlencoded", r.Header.Get("Content-Type"))
			require.Equal(t, "application/json", r.Header.Get("Accept"))
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "authorization_code", r.Form.Get("grant_type"))
			assert.Equal(t, "cid", r.Form.Get("client_id"))
			assert.Equal(t, "secret", r.Form.Get("client_secret"))
			assert.Equal(t, "code-abc", r.Form.Get("code"))
			assert.Equal(t, "https://app.example/callback", r.Form.Get("redirect_uri"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "gho_token"})
		})

		result, err := c.ExchangeCode(context.Background(), "  code-abc  ")
		require.NoError(t, err)
		assert.Equal(t, "gho_token", result.AccessToken)
	})

	t.Run("nil context returns request creation error", func(t *testing.T) {
		t.Parallel()

		c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
		_, err := c.ExchangeCode(nil, "code-abc") //nolint:staticcheck // intentionally nil to hit request-build error
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create auth0 token exchange request")
	})

	t.Run("transport error surfaces request failure", func(t *testing.T) {
		t.Parallel()

		_, err := auth0CoverErrClient().ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "auth0 token exchange request failed")
	})

	t.Run("malformed body returns decode error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode auth0 token exchange response")
	})

	t.Run("non-2xx with error_description", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":             "invalid_grant",
				"error_description": "code already used",
			})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "code already used")
	})

	t.Run("non-2xx with error field only", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid_grant"})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid_grant")
	})

	t.Run("non-2xx with empty body returns status error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "403")
	})

	t.Run("empty access token returns error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "   "})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "empty access token")
	})
}

func TestAuth0_Cover_FetchUser(t *testing.T) {
	t.Parallel()

	t.Run("primary github success", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "/user", r.URL.Path)
			require.Equal(t, "Bearer gh-token", r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 4242, "login": "octo", "name": "The Octocat", "avatar_url": "https://img/octo.png",
			})
		})

		profile, err := c.FetchUser(context.Background(), "gh-token")
		require.NoError(t, err)
		assert.Equal(t, int64(4242), profile.ID)
		assert.Equal(t, "octo", profile.Login)
		assert.Equal(t, "The Octocat", profile.Name)
	})

	t.Run("falls back to userinfo using nickname as login", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sub":      "github|987654",
					"name":     "Grace Hopper",
					"nickname": "grace",
					"picture":  "https://img/grace.png",
					"email":    "grace@example.com",
				})
			},
		}))

		profile, err := c.FetchUser(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Equal(t, "grace", profile.Login)
		assert.Equal(t, "Grace Hopper", profile.Name)
		assert.Equal(t, "https://img/grace.png", profile.AvatarURL)
		// The fallback must yield the SAME provider user ID as the GitHub
		// passthrough path, or a returning user splits into two accounts.
		assert.Equal(t, int64(987654), profile.ID)
	})

	t.Run("falls back to userinfo using name when nickname empty", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sub":  "github|1",
					"name": "Ada Lovelace",
				})
			},
		}))

		profile, err := c.FetchUser(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Equal(t, "Ada Lovelace", profile.Login)
	})

	t.Run("fallback userinfo missing required fields returns error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"sub": "github|1", "email": "x@example.com"})
			},
		}))

		_, err := c.FetchUser(context.Background(), "auth0-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "auth0 userinfo response missing required fields")
	})

	t.Run("fallback userinfo non-2xx returns status error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			},
		}))

		_, err := c.FetchUser(context.Background(), "auth0-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "auth0 userinfo request failed with status 500")
	})

	t.Run("github decode failure falls back to userinfo", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte("not-json"))
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"sub": "github|7", "nickname": "z"})
			},
		}))

		profile, err := c.FetchUser(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Equal(t, "z", profile.Login)
	})

	t.Run("github missing fields falls back to userinfo", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"id": 0, "login": ""})
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"sub": "github|8", "nickname": "y"})
			},
		}))

		profile, err := c.FetchUser(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Equal(t, "y", profile.Login)
	})

	t.Run("userinfo decode failure returns error", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte("not-json"))
			},
		}))

		_, err := c.FetchUser(context.Background(), "auth0-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode auth0 userinfo response")
	})

	t.Run("nil context returns userinfo request creation error", func(t *testing.T) {
		t.Parallel()

		c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
		_, err := c.FetchUser(nil, "auth0-token") //nolint:staticcheck // intentionally nil to hit request-build error
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create auth0 userinfo request")
	})

	t.Run("transport error returns userinfo request failure", func(t *testing.T) {
		t.Parallel()

		_, err := auth0CoverErrClient().FetchUser(context.Background(), "auth0-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "auth0 userinfo request failed")
	})
}

func TestAuth0_Cover_FetchEmails(t *testing.T) {
	t.Parallel()

	t.Run("success returns github emails", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "/user/emails", r.URL.Path)
			require.Equal(t, "Bearer gh-token", r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"email": "primary@example.com", "primary": true, "verified": true},
				{"email": "alt@example.com", "primary": false, "verified": false},
			})
		})

		emails, err := c.FetchEmails(context.Background(), "gh-token")
		require.NoError(t, err)
		require.Len(t, emails, 2)
		assert.Equal(t, "primary@example.com", emails[0].Email)
		assert.True(t, emails[0].Primary)
	})

	t.Run("github error swallowed returns empty slice", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		})

		emails, err := c.FetchEmails(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Empty(t, emails)
		assert.NotNil(t, emails)
	})

	t.Run("auth0 token falls back to verified userinfo email", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user/emails": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sub":            "github|987654",
					"nickname":       "grace",
					"email":          "grace@example.com",
					"email_verified": true,
				})
			},
		}))

		emails, err := c.FetchEmails(context.Background(), "auth0-token")
		require.NoError(t, err)
		require.Len(t, emails, 1)
		assert.Equal(t, "grace@example.com", emails[0].Email)
		assert.True(t, emails[0].Primary)
		assert.True(t, emails[0].Verified)
	})

	t.Run("unverified userinfo email is not marked verified", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user/emails": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sub":            "github|987654",
					"nickname":       "grace",
					"email":          "grace@example.com",
					"email_verified": false,
				})
			},
		}))

		emails, err := c.FetchEmails(context.Background(), "auth0-token")
		require.NoError(t, err)
		require.Len(t, emails, 1)
		assert.Equal(t, "grace@example.com", emails[0].Email)
		assert.False(t, emails[0].Verified)
	})

	t.Run("userinfo without email returns empty slice", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, auth0CoverDispatch(map[string]http.HandlerFunc{
			"/user/emails": func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
			},
			"/userinfo": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"sub": "github|987654", "nickname": "grace"})
			},
		}))

		emails, err := c.FetchEmails(context.Background(), "auth0-token")
		require.NoError(t, err)
		assert.Empty(t, emails)
		assert.NotNil(t, emails)
	})

	t.Run("nil context swallowed returns empty slice", func(t *testing.T) {
		t.Parallel()

		c := NewAuth0Client("tenant.auth0.com", "cid", "secret", "https://app.example/callback", "", "")
		emails, err := c.FetchEmails(nil, "gh-token") //nolint:staticcheck // intentionally nil to hit request-build error
		require.NoError(t, err)
		assert.Empty(t, emails)
	})

	t.Run("transport error swallowed returns empty slice", func(t *testing.T) {
		t.Parallel()

		emails, err := auth0CoverErrClient().FetchEmails(context.Background(), "gh-token")
		require.NoError(t, err)
		assert.Empty(t, emails)
	})

	t.Run("decode error swallowed returns empty slice", func(t *testing.T) {
		t.Parallel()

		c := auth0CoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("not-json"))
		})
		emails, err := c.FetchEmails(context.Background(), "gh-token")
		require.NoError(t, err)
		assert.Empty(t, emails)
	})
}

func TestAuth0_Cover_auth0GitHubID(t *testing.T) {
	t.Parallel()

	// GitHub subs must yield the real numeric GitHub ID so the userinfo
	// fallback matches the passthrough path's provider user ID.
	assert.Equal(t, int64(583231), auth0GitHubID("github|583231"))
	assert.Equal(t, int64(583231), auth0GitHubID("  github|583231  "))

	// Non-GitHub or malformed subs fall back to the deterministic hash.
	assert.Equal(t, stableInt64ID("google-oauth2|12345"), auth0GitHubID("google-oauth2|12345"))
	assert.Equal(t, stableInt64ID("github|not-a-number"), auth0GitHubID("github|not-a-number"))
	assert.Equal(t, stableInt64ID("github|-5"), auth0GitHubID("github|-5"))
	assert.Equal(t, stableInt64ID("github|0"), auth0GitHubID("github|0"))
}

func TestAuth0_Cover_stableInt64ID(t *testing.T) {
	t.Parallel()

	a := stableInt64ID("github|987654")
	b := stableInt64ID("  github|987654  ") // trimmed → same identity
	c := stableInt64ID("github|111111")

	assert.Positive(t, a, "id must be a non-negative positive int64")
	assert.Equal(t, a, b, "same identity (after trim) yields the same id")
	assert.NotEqual(t, a, c, "different identities yield different ids")
}

// auth0CoverDispatch routes requests by path to per-path handlers, failing the
// test if an unexpected path is hit.
func auth0CoverDispatch(routes map[string]http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h, ok := routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		http.Error(w, "unexpected path: "+r.URL.Path, http.StatusNotFound)
	}
}
