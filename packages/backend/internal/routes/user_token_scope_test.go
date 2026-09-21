package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// A token-authenticated request to create a token must not be able to grant the
// new token scopes the authenticating token does not itself hold — otherwise a
// leaked low-privilege PAT could escalate into a broadly-scoped token.
func TestPostUserToken_TokenAuthCannotEscalateScopes(t *testing.T) {
	user := &db.User{ID: 7, Username: "bob", LowerUsername: "bob"}

	run := func(info *middleware.AuthInfo, body string) (*httptest.ResponseRecorder, *bool) {
		created := false
		h := UserHandler{TokenService: mockUserTokenService{
			createTokenFn: func(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
				created = true
				return services.CreateTokenResult{
					TokenSummary: services.TokenSummary{ID: 1, Name: req.Name},
					Token:        "smithers_generated",
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/user/tokens", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), info))
		rec := httptest.NewRecorder()
		h.PostUserToken(rec, req)
		return rec, &created
	}

	t.Run("rejects requesting a scope the caller lacks", func(t *testing.T) {
		info := &middleware.AuthInfo{
			User:        user,
			IsTokenAuth: true,
			Scopes:      middleware.ParseTokenScopes("read:repository"),
		}
		rec, created := run(info, `{"name":"escalate","scopes":["repo"]}`) // repo == write:repository
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for scope escalation, got %d (%s)", rec.Code, rec.Body.String())
		}
		if *created {
			t.Fatal("CreateToken must not be called when scopes exceed the caller's")
		}
	})

	t.Run("allows requesting a scope the caller holds", func(t *testing.T) {
		info := &middleware.AuthInfo{
			User:        user,
			IsTokenAuth: true,
			Scopes:      middleware.ParseTokenScopes("repo"), // write:repository (implies read)
		}
		rec, created := run(info, `{"name":"ok","scopes":["read:repo"]}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201 for in-scope token, got %d (%s)", rec.Code, rec.Body.String())
		}
		if !*created {
			t.Fatal("CreateToken should be called for an in-scope request")
		}
	})

	t.Run("session auth is not scope-constrained", func(t *testing.T) {
		info := &middleware.AuthInfo{
			User:        user,
			IsTokenAuth: false,
			Scopes:      middleware.ScopeSet{},
		}
		rec, created := run(info, `{"name":"session","scopes":["repo"]}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201 for session auth, got %d (%s)", rec.Code, rec.Body.String())
		}
		if !*created {
			t.Fatal("CreateToken should be called for session auth")
		}
	})
}
