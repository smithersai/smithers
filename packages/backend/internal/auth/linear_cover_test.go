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

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// linearCoverRewriteRT rewrites the scheme+host of every outbound request to a
// test server while preserving the path, so Linear's hard-coded endpoint URLs
// can be exercised against httptest.
type linearCoverRewriteRT struct {
	base *url.URL
}

func (rt linearCoverRewriteRT) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = rt.base.Scheme
	req.URL.Host = rt.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

// linearCoverErrRT always fails the round trip, simulating a transport error.
type linearCoverErrRT struct {
	err error
}

func (rt linearCoverErrRT) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, rt.err
}

func linearCoverClient(t *testing.T, h http.HandlerFunc) *LinearClient {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base, err := url.Parse(srv.URL)
	require.NoError(t, err)

	c := NewLinearClient("client-id", "client-secret", "https://app.example/callback")
	c.httpClient = &http.Client{Transport: linearCoverRewriteRT{base: base}}
	return c
}

func linearCoverErrClient() *LinearClient {
	c := NewLinearClient("client-id", "client-secret", "https://app.example/callback")
	c.httpClient = &http.Client{Transport: linearCoverErrRT{err: errors.New("boom transport")}}
	return c
}

func TestLinear_Cover_NewLinearClient(t *testing.T) {
	t.Parallel()

	c := NewLinearClient("  cid  ", "  secret  ", "  https://app.example/callback  ")
	assert.Equal(t, "cid", c.clientID)
	assert.Equal(t, "secret", c.clientSecret)
	assert.Equal(t, "https://app.example/callback", c.redirectURL)
	require.NotNil(t, c.httpClient)
	assert.Equal(t, 10*time.Second, c.httpClient.Timeout)
}

func TestLinear_Cover_AuthorizationURL(t *testing.T) {
	t.Parallel()

	c := NewLinearClient("cid", "secret", "https://app.example/callback")
	raw := c.AuthorizationURL("state-xyz")
	parsed, err := url.Parse(raw)
	require.NoError(t, err)

	assert.Equal(t, "https", parsed.Scheme)
	assert.Equal(t, "linear.app", parsed.Host)
	assert.Equal(t, "/oauth/authorize", parsed.Path)
	q := parsed.Query()
	assert.Equal(t, "cid", q.Get("client_id"))
	assert.Equal(t, "https://app.example/callback", q.Get("redirect_uri"))
	assert.Equal(t, "code", q.Get("response_type"))
	assert.Equal(t, "state-xyz", q.Get("state"))
	assert.Equal(t, "read,write,issues:create,comments:create", q.Get("scope"))
	assert.Equal(t, "app", q.Get("actor"))
}

func TestLinear_Cover_FetchIssue(t *testing.T) {
	t.Parallel()

	c := linearCoverClient(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/graphql", r.URL.Path)
		assert.Equal(t, "Bearer access-token", r.Header.Get("Authorization"))
		var payload struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		assert.Contains(t, payload.Query, "team { id name key }")
		assert.Equal(t, "ENG-482", payload.Variables["identifier"])
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"issue": map[string]any{
					"id":         "linear-482",
					"identifier": "ENG-482",
					"team":       map[string]any{"id": "team-eng", "name": "Engineering", "key": "ENG"},
				},
			},
		})
	})

	issue, err := c.FetchIssue(context.Background(), "access-token", "  ENG-482  ")
	require.NoError(t, err)
	assert.Equal(t, "linear-482", issue.ID)
	assert.Equal(t, "ENG-482", issue.Identifier)
	assert.Equal(t, "team-eng", issue.Team.ID)
}

func TestLinear_Cover_ExchangeCode(t *testing.T) {
	t.Parallel()

	t.Run("success populates result and expiry", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/oauth/token", r.URL.Path)
			require.Equal(t, "application/x-www-form-urlencoded", r.Header.Get("Content-Type"))
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "client-id", r.Form.Get("client_id"))
			assert.Equal(t, "client-secret", r.Form.Get("client_secret"))
			assert.Equal(t, "code-abc", r.Form.Get("code"))
			assert.Equal(t, "https://app.example/callback", r.Form.Get("redirect_uri"))
			assert.Equal(t, "authorization_code", r.Form.Get("grant_type"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "lin_access",
				"refresh_token": "lin_refresh",
				"expires_in":    3600,
			})
		})

		before := time.Now().UTC()
		result, err := c.ExchangeCode(context.Background(), "  code-abc  ")
		require.NoError(t, err)
		assert.Equal(t, "lin_access", result.AccessToken)
		assert.Equal(t, "lin_refresh", result.RefreshToken)
		assert.False(t, result.ExpiresAt.IsZero())
		assert.WithinDuration(t, before.Add(3600*time.Second), result.ExpiresAt, 5*time.Second)
	})

	t.Run("success without expires_in leaves zero expiry", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "lin_access"})
		})

		result, err := c.ExchangeCode(context.Background(), "code-abc")
		require.NoError(t, err)
		assert.Equal(t, "lin_access", result.AccessToken)
		assert.True(t, result.ExpiresAt.IsZero())
	})

	t.Run("nil context returns request creation error", func(t *testing.T) {
		t.Parallel()

		c := NewLinearClient("cid", "secret", "https://app.example/callback")
		_, err := c.ExchangeCode(nil, "code-abc") //nolint:staticcheck // intentionally nil to hit request-build error
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create linear oauth exchange request")
	})

	t.Run("transport error surfaces request failure", func(t *testing.T) {
		t.Parallel()

		_, err := linearCoverErrClient().ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "linear oauth exchange request failed")
	})

	t.Run("malformed body returns decode error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode linear oauth exchange response")
	})

	t.Run("non-2xx with error_description", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":             "invalid_request",
				"error_description": "bad code supplied",
			})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "bad code supplied")
	})

	t.Run("non-2xx with error field only", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid_request"})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid_request")
	})

	t.Run("non-2xx with empty body returns status error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "503")
	})

	t.Run("empty access token returns error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "   "})
		})
		_, err := c.ExchangeCode(context.Background(), "code-abc")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "empty access token")
	})
}

func TestLinear_Cover_RefreshToken(t *testing.T) {
	t.Parallel()

	t.Run("success populates result and expiry", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/oauth/token", r.URL.Path)
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "refresh_token", r.Form.Get("grant_type"))
			assert.Equal(t, "rt_old", r.Form.Get("refresh_token"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "lin_new",
				"refresh_token": "rt_new",
				"expires_in":    7200,
			})
		})

		before := time.Now().UTC()
		result, err := c.RefreshToken(context.Background(), "  rt_old  ")
		require.NoError(t, err)
		assert.Equal(t, "lin_new", result.AccessToken)
		assert.Equal(t, "rt_new", result.RefreshToken)
		assert.WithinDuration(t, before.Add(7200*time.Second), result.ExpiresAt, 5*time.Second)
	})

	t.Run("success without expires_in leaves zero expiry", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "lin_new"})
		})
		result, err := c.RefreshToken(context.Background(), "rt_old")
		require.NoError(t, err)
		assert.True(t, result.ExpiresAt.IsZero())
	})

	t.Run("nil context returns request creation error", func(t *testing.T) {
		t.Parallel()

		c := NewLinearClient("cid", "secret", "https://app.example/callback")
		_, err := c.RefreshToken(nil, "rt_old") //nolint:staticcheck // intentionally nil to hit request-build error
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create linear token refresh request")
	})

	t.Run("transport error surfaces request failure", func(t *testing.T) {
		t.Parallel()

		_, err := linearCoverErrClient().RefreshToken(context.Background(), "rt_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "linear token refresh request failed")
	})

	t.Run("malformed body returns decode error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		})
		_, err := c.RefreshToken(context.Background(), "rt_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode linear token refresh response")
	})

	t.Run("non-2xx with error_description", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error_description": "refresh token expired",
			})
		})
		_, err := c.RefreshToken(context.Background(), "rt_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "refresh token expired")
	})

	t.Run("non-2xx without description returns status error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		})
		_, err := c.RefreshToken(context.Background(), "rt_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "401")
	})

	t.Run("empty access token returns error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": ""})
		})
		_, err := c.RefreshToken(context.Background(), "rt_old")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "empty access token")
	})
}

func TestLinear_Cover_FetchViewer(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/graphql", r.URL.Path)
			require.Equal(t, "Bearer tok-123", r.Header.Get("Authorization"))
			require.Equal(t, "application/json", r.Header.Get("Content-Type"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"viewer": map[string]any{"id": "u1", "email": "a@example.com", "name": "Ada"},
				},
			})
		})

		viewer, err := c.FetchViewer(context.Background(), "tok-123")
		require.NoError(t, err)
		assert.Equal(t, services.LinearViewer{ID: "u1", Email: "a@example.com", Name: "Ada"}, viewer)
	})

	t.Run("propagates graphql error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errors": []map[string]any{{"message": "not authorized"}},
			})
		})
		_, err := c.FetchViewer(context.Background(), "tok-123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not authorized")
	})
}

func TestLinear_Cover_FetchTeams(t *testing.T) {
	t.Parallel()

	t.Run("success returns nodes", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "/graphql", r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"teams": map[string]any{
						"nodes": []map[string]any{
							{"id": "t1", "name": "Smithers", "key": "SMI"},
							{"id": "t2", "name": "Ops", "key": "OPS"},
						},
					},
				},
			})
		})

		teams, err := c.FetchTeams(context.Background(), "tok-123")
		require.NoError(t, err)
		require.Len(t, teams, 2)
		assert.Equal(t, services.LinearTeam{ID: "t1", Name: "Smithers", Key: "SMI"}, teams[0])
		assert.Equal(t, "OPS", teams[1].Key)
	})

	t.Run("error propagates and returns nil slice", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("boom"))
		})
		teams, err := c.FetchTeams(context.Background(), "tok-123")
		require.Error(t, err)
		assert.Nil(t, teams)
	})
}

func TestLinear_Cover_linearGraphQL(t *testing.T) {
	t.Parallel()

	body := `{"query":"{ viewer { id } }"}`

	t.Run("nil context returns request creation error", func(t *testing.T) {
		t.Parallel()

		//nolint:staticcheck // intentionally nil to hit request-build error
		_, err := linearGraphQL[services.LinearViewer](nil, http.DefaultClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create linear graphql request")
	})

	t.Run("transport error surfaces request failure", func(t *testing.T) {
		t.Parallel()

		client := &http.Client{Transport: linearCoverErrRT{err: errors.New("boom transport")}}
		_, err := linearGraphQL[services.LinearViewer](context.Background(), client, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "linear graphql request failed")
	})

	t.Run("non-2xx status via rewrite client", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		})
		_, err := linearGraphQL[services.LinearViewer](context.Background(), c.httpClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "502")
	})

	t.Run("malformed body returns decode error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		})
		_, err := linearGraphQL[services.LinearViewer](context.Background(), c.httpClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "decode linear graphql response")
	})

	t.Run("graphql errors present", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errors": []map[string]any{{"message": "rate limited"}},
			})
		})
		_, err := linearGraphQL[services.LinearViewer](context.Background(), c.httpClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "rate limited")
	})

	t.Run("missing data key", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"something_else": map[string]any{}},
			})
		})
		_, err := linearGraphQL[services.LinearViewer](context.Background(), c.httpClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), `missing "viewer" field`)
	})

	t.Run("data key with wrong shape returns unmarshal error", func(t *testing.T) {
		t.Parallel()

		c := linearCoverClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"viewer": "not-an-object"},
			})
		})
		_, err := linearGraphQL[services.LinearViewer](context.Background(), c.httpClient, "tok", body, "viewer")
		require.Error(t, err)
		assert.Contains(t, err.Error(), `decode linear graphql "viewer"`)
	})
}
