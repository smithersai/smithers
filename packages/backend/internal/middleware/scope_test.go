package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestParseTokenScopes_Has(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		raw      string
		required TokenScope
		want     bool
	}{
		{
			name:     "write repository implies read repository",
			raw:      "write:repository",
			required: ScopeReadRepository,
			want:     true,
		},
		{
			name:     "write user implies read user",
			raw:      "write:user",
			required: ScopeReadUser,
			want:     true,
		},
		{
			name:     "read user does not imply write user",
			raw:      "read:user",
			required: ScopeWriteUser,
			want:     false,
		},
		{
			name:     "read repository does not imply write repository",
			raw:      "read:repository",
			required: ScopeWriteRepository,
			want:     false,
		},
		{
			name:     "all satisfies all scopes",
			raw:      "all",
			required: ScopeWriteRepository,
			want:     true,
		},
		{
			name:     "empty scope set denies access",
			raw:      "",
			required: ScopeReadRepository,
			want:     false,
		},
		{
			name:     "compatibility alias repo maps to write repository",
			raw:      "repo",
			required: ScopeWriteRepository,
			want:     true,
		},
		{
			name:     "compatibility alias user maps to write user",
			raw:      "user",
			required: ScopeWriteUser,
			want:     true,
		},
		{
			name:     "compatibility alias repository maps to write repository",
			raw:      "repository",
			required: ScopeWriteRepository,
			want:     true,
		},
		{
			name:     "read repo alias maps to read repository",
			raw:      "read:repo",
			required: ScopeReadRepository,
			want:     true,
		},
		{
			name:     "write workspace implies read workspace",
			raw:      "write:workspace",
			required: ScopeReadWorkspace,
			want:     true,
		},
		{
			name:     "write approval implies read approval",
			raw:      "write:approval",
			required: ScopeReadApproval,
			want:     true,
		},
		{
			name:     "write agent implies read agent",
			raw:      "write:agent",
			required: ScopeReadAgent,
			want:     true,
		},
		{
			name:     "multiple scopes parse correctly",
			raw:      "write:repository,read:user",
			required: ScopeReadUser,
			want:     true,
		},
		{
			name:     "write admin implies read admin",
			raw:      "write:admin",
			required: ScopeReadAdmin,
			want:     true,
		},
		{
			name:     "admin alias implies write admin",
			raw:      "admin",
			required: ScopeWriteAdmin,
			want:     true,
		},
		{
			name:     "read admin does not imply write admin",
			raw:      "read:admin",
			required: ScopeWriteAdmin,
			want:     false,
		},
		{
			name:     "admin alias no longer grants repository write",
			raw:      "admin",
			required: ScopeWriteRepository,
			want:     false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, ParseTokenScopes(tc.raw).Has(tc.required))
		})
	}
}

func TestParseTokenScopes_OrganizationScopes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		raw      string
		required TokenScope
		want     bool
	}{
		{
			name:     "write organization implies read organization",
			raw:      "write:organization",
			required: ScopeReadOrganization,
			want:     true,
		},
		{
			name:     "organization alias maps to write organization",
			raw:      "organization",
			required: ScopeWriteOrganization,
			want:     true,
		},
		{
			name:     "org alias maps to write organization",
			raw:      "org",
			required: ScopeWriteOrganization,
			want:     true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, ParseTokenScopes(tc.raw).Has(tc.required))
		})
	}
}

func TestParseTokenScopes_RejectsUnknownScopes(t *testing.T) {
	t.Parallel()

	parsed := ParseTokenScopes("write:repository,admin:destroy")
	_, hasUnknown := parsed[TokenScope("admin:destroy")]

	assert.False(t, hasUnknown)
	assert.True(t, parsed.Has(ScopeWriteRepository))
}

// Legacy rows store scopes space-joined; tokens minted since 2026-07 store
// them comma-joined. Both must parse to the same scope set — a parser that
// honors only one separator silently strips the other cohort's scopes.
func TestParseTokenScopes_AcceptsSpaceAndCommaSeparators(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		"read:user read:repository write:repository",
		"read:user,read:repository,write:repository",
		"read:user, read:repository write:repository",
		" read:user  read:repository  write:repository ",
	} {
		parsed := ParseTokenScopes(raw)
		assert.True(t, parsed.Has(ScopeReadUser), raw)
		assert.True(t, parsed.Has(ScopeReadRepository), raw)
		assert.True(t, parsed.Has(ScopeWriteRepository), raw)
	}
}

func TestParseTokenRepositoryRestriction(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "repo:314", RepositoryRestrictionScope(314))

	// The binding entry is a restriction, never a permission grant.
	parsed := ParseTokenScopes("write:repository,repo:314")
	_, hasRestrictionAsScope := parsed[TokenScope("repo:314")]
	assert.False(t, hasRestrictionAsScope)
	assert.True(t, parsed.Has(ScopeWriteRepository))

	assert.Equal(t, int64(314), ParseTokenRepositoryRestriction("write:repository,repo:314"))
	assert.Equal(t, int64(314), ParseTokenRepositoryRestriction(" REPO:314 ,write:repository"))
	assert.Equal(t, int64(0), ParseTokenRepositoryRestriction("write:repository"))
	assert.Equal(t, int64(0), ParseTokenRepositoryRestriction("repo:abc"))
	assert.Equal(t, int64(0), ParseTokenRepositoryRestriction("repo:-5"))
	assert.Equal(t, int64(0), ParseTokenRepositoryRestriction(""))
	// Bare "repo" is the legacy write:repository alias, not a binding.
	assert.Equal(t, int64(0), ParseTokenRepositoryRestriction("repo"))

	// AuthInfo derives the restriction from RawScopes for token auth only.
	tokenInfo := &AuthInfo{IsTokenAuth: true, RawScopes: "write:repository,repo:314"}
	assert.Equal(t, int64(314), tokenInfo.RepositoryRestriction())
	sessionInfo := &AuthInfo{IsTokenAuth: false, RawScopes: "write:repository,repo:314"}
	assert.Equal(t, int64(0), sessionInfo.RepositoryRestriction())
	var nilInfo *AuthInfo
	assert.Equal(t, int64(0), nilInfo.RepositoryRestriction())
}

func TestTokenPathRestrictionsRoundTrip(t *testing.T) {
	t.Parallel()
	encoded := PathRestrictionScopes([]string{"src/**", "docs/read me.md", "src/**", ""})
	require.Len(t, encoded, 2)
	raw := "write:repository,repo:42," + strings.Join(encoded, ",")
	assert.Equal(t, []string{"src/**", "docs/read me.md"}, ParseTokenPathRestrictions(raw))
	assert.True(t, ParseTokenScopes(raw).Has(ScopeWriteRepository), "restriction entries never grant or hide the real permission")
}

func TestTokenAgentSessionRestrictionRoundTrip(t *testing.T) {
	t.Parallel()
	sessionID := "11111111-1111-4111-8111-111111111111"
	raw := "write:repository,repo:42," + AgentSessionRestrictionScope(sessionID)
	assert.Equal(t, sessionID, ParseTokenAgentSessionRestriction(raw))
	assert.Empty(t, ParseTokenAgentSessionRestriction("write:repository,repo:42"))
	assert.True(t, ParseTokenScopes(raw).Has(ScopeWriteRepository), "session restriction remains permission-inert")
}

func TestRequireScope(t *testing.T) {
	t.Parallel()

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("token auth missing required scope returns 403", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice"},
			IsTokenAuth: true,
			TokenID:     55,
			RawScopes:   "read:repository",
			Scopes:      ParseTokenScopes("read:repository"),
		}))

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("token auth with required scope allows request", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice"},
			IsTokenAuth: true,
			TokenID:     77,
			RawScopes:   "write:repository",
			Scopes:      ParseTokenScopes("write:repository"),
		}))

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("non token auth bypasses scope gate", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 2, Username: "session-user"},
			IsTokenAuth: false,
		}))

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})
}

func TestRequireTokenScope(t *testing.T) {
	t.Parallel()

	t.Run("anonymous request bypasses optional token scope", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireTokenScope(ScopeReadRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("token auth missing scope returns 403", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireTokenScope(ScopeReadRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice"},
			IsTokenAuth: true,
			TokenID:     99,
			RawScopes:   "read:user",
			Scopes:      ParseTokenScopes("read:user"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.False(t, nextCalled)
	})

	t.Run("token auth with required scope allows request", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireTokenScope(ScopeReadRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice"},
			IsTokenAuth: true,
			TokenID:     100,
			RawScopes:   "read:repository",
			Scopes:      ParseTokenScopes("read:repository"),
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})
}

func TestContextWithAuthInfo_RoundTrip(t *testing.T) {
	t.Parallel()

	info := &AuthInfo{
		User: &db.User{
			ID:            41,
			Username:      "roundtrip-user",
			LowerUsername: "roundtrip-user",
		},
		TokenID:     901,
		RawScopes:   "write:user",
		Scopes:      ParseTokenScopes("write:user"),
		IsTokenAuth: true,
	}

	ctx := ContextWithAuthInfo(context.Background(), info)
	gotInfo := AuthInfoFromContext(ctx)
	require.NotNil(t, gotInfo)
	assert.Equal(t, info, gotInfo)

	gotUser := UserFromContext(ctx)
	require.NotNil(t, gotUser)
	assert.Equal(t, info.User.ID, gotUser.ID)
	assert.Equal(t, info.User.Username, gotUser.Username)
}

func TestScopeSet_Has_NilScopeSet(t *testing.T) {
	t.Parallel()

	var s ScopeSet
	assert.False(t, s.Has(ScopeReadRepository))
	assert.False(t, s.Has(ScopeAll))
}

func TestScopeSet_Has_AdminScopeIsLimitedToAdminRoutes(t *testing.T) {
	t.Parallel()

	s := ParseTokenScopes("admin")
	assert.True(t, s.Has(ScopeReadAdmin))
	assert.True(t, s.Has(ScopeWriteAdmin))
	assert.False(t, s.Has(ScopeReadRepository))
	assert.False(t, s.Has(ScopeWriteRepository))
}

func TestNormalizeScope_UnknownReturnsEmpty(t *testing.T) {
	t.Parallel()

	scope := NormalizeTokenScope("delete:everything")
	assert.Equal(t, TokenScope(""), scope)
}

func TestNormalizeScope_WhitespaceAndCase(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  TokenScope
	}{
		{"  Write:Repository  ", ScopeWriteRepository},
		{"ALL", ScopeAll},
		{"  admin  ", ScopeAdmin},
		{"admin:read", ScopeReadAdmin},
		{"admin:write", ScopeWriteAdmin},
		{"READ:ADMIN", ScopeReadAdmin},
		{"WRITE:ADMIN", ScopeWriteAdmin},
		{"REPO", ScopeWriteRepository},
		{"  User  ", ScopeWriteUser},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, NormalizeTokenScope(tc.input))
		})
	}
}

func TestNormalizeScope_EmptyString(t *testing.T) {
	t.Parallel()

	assert.Equal(t, TokenScope(""), NormalizeTokenScope(""))
	assert.Equal(t, TokenScope(""), NormalizeTokenScope("   "))
}

func TestRequireScope_AdminScope(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireScope(ScopeWriteAdmin)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        &db.User{ID: 1, Username: "admin-user"},
		IsTokenAuth: true,
		TokenID:     10,
		RawScopes:   "admin",
		Scopes:      ParseTokenScopes("admin"),
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, nextCalled, "admin scope should satisfy admin write scope")
}

func TestRequireScope_AdminScopeDoesNotGrantRepositoryScopes(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        &db.User{ID: 1, Username: "admin-user"},
		IsTokenAuth: true,
		TokenID:     10,
		RawScopes:   "admin",
		Scopes:      ParseTokenScopes("admin"),
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.False(t, nextCalled)
}

func TestRequireScope_AllScope(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireScope(ScopeWriteUser)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/user/settings", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        &db.User{ID: 1, Username: "all-scope-user"},
		IsTokenAuth: true,
		TokenID:     20,
		RawScopes:   "all",
		Scopes:      ParseTokenScopes("all"),
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, nextCalled, "all scope should satisfy any required scope")
}

func TestRequireScope_NilUserInAuthInfoReturns401(t *testing.T) {
	t.Parallel()

	handler := RequireScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User: nil, // nil user
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAuthInfoFromContext_NilContext(t *testing.T) {
	t.Parallel()

	info := AuthInfoFromContext(context.Background())
	assert.Nil(t, info)
}

func TestRequireTokenScope_TokenAuthNilUserReturns401(t *testing.T) {
	t.Parallel()

	handler := RequireTokenScope(ScopeReadRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        nil, // Token auth but no user
		IsTokenAuth: true,
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireTokenScope_NonTokenAuthNilUserBypasses(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireTokenScope(ScopeReadRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        nil, // Not token auth, nil user
		IsTokenAuth: false,
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, nextCalled)
}

func TestRequireTokenScope_NonTokenAuthWithUserBypasses(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := RequireTokenScope(ScopeWriteRepository)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo", nil)
	req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
		User:        &db.User{ID: 1, Username: "alice"},
		IsTokenAuth: false, // session auth — bypasses scope check
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, nextCalled)
}

func TestRequireFirstPartyAuth(t *testing.T) {
	t.Parallel()

	t.Run("session auth is allowed", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireFirstPartyAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/user/keys", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 1, Username: "alice"},
			IsTokenAuth: false,
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("personal access token is allowed", func(t *testing.T) {
		t.Parallel()

		nextCalled := false
		handler := RequireFirstPartyAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/user/keys", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 2, Username: "bob"},
			IsTokenAuth: true,
			TokenSource: TokenSourcePersonalAccessToken,
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNoContent, rec.Code)
		assert.True(t, nextCalled)
	})

	t.Run("oauth2 token is rejected", func(t *testing.T) {
		t.Parallel()

		handler := RequireFirstPartyAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatal("handler should not be called")
		}))

		req := httptest.NewRequest(http.MethodGet, "/api/user/keys", nil)
		req = req.WithContext(context.WithValue(req.Context(), authInfoContextKey, &AuthInfo{
			User:        &db.User{ID: 3, Username: "oauth-app"},
			IsTokenAuth: true,
			TokenSource: TokenSourceOAuth2AccessToken,
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, "oauth2 access tokens cannot manage smithers credentials", apiErrorMessage(t, rec))
	})
}

func TestNormalizeTokenScope_ExportedReadScopes(t *testing.T) {
	t.Parallel()

	assert.Equal(t, ScopeReadAdmin, NormalizeTokenScope("read:admin"))
	assert.Equal(t, ScopeReadOrganization, NormalizeTokenScope("read:organization"))
	assert.Equal(t, ScopeReadUser, NormalizeTokenScope("read:user"))
	assert.Equal(t, ScopeReadRepository, NormalizeTokenScope("read:repo"))
	assert.Equal(t, ScopeWriteWorkspace, NormalizeTokenScope("write:workspace"))
	assert.Equal(t, ScopeWriteApproval, NormalizeTokenScope("write:approval"))
	assert.Equal(t, ScopeWriteAgent, NormalizeTokenScope("write:agent"))
}
