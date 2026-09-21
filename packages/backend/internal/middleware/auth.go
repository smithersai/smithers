package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type contextKey string

// UserContextKey is the context key for storing the authenticated user.
// Exported for use in tests.
const UserContextKey contextKey = "user"

// UserFromContext retrieves the authenticated user from the request context.
// AuthInfo is the canonical auth context used by scope-aware middleware.
// The legacy UserContextKey fallback is kept for compatibility with handlers
// that still read only the user value directly.
func UserFromContext(ctx context.Context) *db.User {
	if authInfo := AuthInfoFromContext(ctx); authInfo != nil && authInfo.User != nil {
		return authInfo.User
	}
	u, _ := ctx.Value(UserContextKey).(*db.User)
	return u
}

// UserQuerier defines the database operations needed by auth middleware.
type UserQuerier interface {
	GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// AuthLoaderQuerier defines the database operations needed by AuthLoader.
type AuthLoaderQuerier interface {
	GetAuthSessionBySessionKey(ctx context.Context, sessionKey string) (db.AuthSession, error)
	RefreshAuthSession(ctx context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error)
	GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	UpdateAccessTokenLastUsed(ctx context.Context, id int64) error
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// TokenAuth returns middleware that authenticates requests via API token.
// It accepts token/Bearer schemes and HTTP Basic credentials whose password is
// a Smithers token. Basic support is required by Git's credential-helper flow,
// including the standard Git LFS HTTP transport; the username is ignored.
func TokenAuth(queries UserQuerier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := ExtractToken(r)
			if token == "" {
				errors.WriteError(w, errors.Unauthorized("authentication required"))
				return
			}

			// SHA-256 hash the token
			hash := sha256.Sum256([]byte(token))
			tokenHash := hex.EncodeToString(hash[:])

			authRow, err := queries.GetAuthInfoByTokenHash(r.Context(), tokenHash)
			if err != nil {
				if !stdErrors.Is(err, pgx.ErrNoRows) {
					errors.WriteError(w, errors.Internal("internal server error"))
					return
				}

				oauthInfo, oauthErr := loadOAuth2AccessToken(r.Context(), queries, tokenHash)
				if oauthErr != nil {
					if stdErrors.Is(oauthErr, pgx.ErrNoRows) {
						errors.WriteError(w, errors.Unauthorized("invalid or expired token"))
						return
					}
					errors.WriteError(w, errors.Internal("internal server error"))
					return
				}

				ctx := ContextWithAuthInfo(r.Context(), oauthInfo)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			user := authRowToUser(authRow)
			if user.ProhibitLogin {
				errors.WriteError(w, errors.Forbidden("account is suspended"))
				return
			}

			authInfo := &AuthInfo{
				User:        &user,
				TokenID:     authRow.TokenID,
				TokenHash:   tokenHash,
				RawScopes:   authRow.TokenScopes,
				Scopes:      ParseTokenScopes(authRow.TokenScopes),
				IsTokenAuth: true,
				TokenSource: TokenSourcePersonalAccessToken,
			}

			if !allowWorkspaceRestrictedToken(w, r, authInfo) {
				return
			}
			ctx := ContextWithAuthInfo(r.Context(), authInfo)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// workspaceHeadReportPath matches the one API route a workspace-restricted
// token may call: POST /api/repos/{owner}/{repo}/workspaces/{id}/head.
var workspaceHeadReportPath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/workspaces/([^/]+)/head$`)

// allowWorkspaceRestrictedToken confines a workspace-bound token (RFD-004) to
// its own head report route. Git smart HTTP lives outside /api and applies its
// own ref policy. It writes the 403 itself and returns false when refused.
func allowWorkspaceRestrictedToken(w http.ResponseWriter, r *http.Request, info *AuthInfo) bool {
	workspaceID := info.WorkspaceRestriction()
	if workspaceID == "" || !strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	if r.Method == http.MethodPost {
		if m := workspaceHeadReportPath.FindStringSubmatch(r.URL.Path); m != nil && strings.EqualFold(m[1], workspaceID) {
			return true
		}
	}
	errors.WriteError(w, errors.Forbidden("workspace credentials may only report their own workspace head"))
	return false
}

// RequireAuth ensures a previous auth middleware attached a user to context.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			errors.WriteError(w, errors.Unauthorized("authentication required"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AuthLoader loads session/cookie or token auth information if available.
// This middleware is a soft gate: anonymous requests continue to next handler.
func AuthLoader(queries AuthLoaderQuerier, cfg config.AuthConfig) func(http.Handler) http.Handler {
	sessionCookieName := strings.TrimSpace(cfg.SessionCookieName)
	if sessionCookieName == "" {
		sessionCookieName = "smithers_session"
	}

	sessionDuration, err := time.ParseDuration(cfg.SessionDuration)
	if err != nil || sessionDuration <= 0 {
		sessionDuration = 720 * time.Hour
	}

	sessionRefreshWindow, err := time.ParseDuration(cfg.SessionRefreshWindow)
	if err != nil || sessionRefreshWindow < 0 {
		sessionRefreshWindow = 168 * time.Hour
	}

	cookieSecure := cfg.CookieSecure

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			now := time.Now().UTC()

			token := ExtractToken(r)
			if token != "" {
				if authInfo := loadTokenAuth(ctx, queries, token); authInfo != nil {
					if !allowWorkspaceRestrictedToken(w, r, authInfo) {
						return
					}
					next.ServeHTTP(w, r.WithContext(ContextWithAuthInfo(ctx, authInfo)))
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
				authInfo, refreshedSession, sessionExpiresAt := loadSessionAuth(ctx, queries, cookie.Value, now, sessionDuration, sessionRefreshWindow)
				if authInfo != nil {
					if refreshedSession != nil {
						http.SetCookie(w, &http.Cookie{
							Name: sessionCookieName,
							// Refresh extends expiry only; re-set the RAW key the
							// client presented. The row's session_key is now a
							// storage digest (see sessionStorageKey), so echoing
							// refreshedSession.SessionKey here would log the user
							// out on their next request.
							Value:    cookie.Value,
							Path:     "/",
							HttpOnly: true,
							Secure:   cookieSecure,
							SameSite: http.SameSiteLaxMode,
							Expires:  refreshedSession.ExpiresAt,
							MaxAge:   int(time.Until(refreshedSession.ExpiresAt).Seconds()),
						})
						// The CSRF cookie must stay in lockstep with the session
						// cookie's lifetime, otherwise it silently expires first and
						// blocks every mutation for a still-logged-in user (#207).
						if token, err := NewCSRFToken(); err == nil {
							SetCSRFCookie(w, token, cookieSecure, refreshedSession.ExpiresAt)
						} else {
							slog.Error("failed to mint refreshed csrf token", "error", err)
						}
					} else if csrfCookie, err := r.Cookie(CSRFCookieName); err != nil || csrfCookie.Value == "" {
						// Self-heal: a valid session with no (or empty) CSRF cookie —
						// e.g. a persistent session cookie that outlived a
						// session-scoped CSRF cookie set before this fix — mints one
						// so the client can resume making mutating requests.
						if token, err := NewCSRFToken(); err == nil {
							SetCSRFCookie(w, token, cookieSecure, sessionExpiresAt)
						} else {
							slog.Error("failed to mint csrf token", "error", err)
						}
					}
					next.ServeHTTP(w, r.WithContext(ContextWithAuthInfo(ctx, authInfo)))
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func loadSessionAuth(
	ctx context.Context,
	queries AuthLoaderQuerier,
	sessionKey string,
	now time.Time,
	sessionDuration time.Duration,
	sessionRefreshWindow time.Duration,
) (*AuthInfo, *db.AuthSession, time.Time) {
	// Sessions minted after keys were hashed at rest are filed under the
	// key's SHA-256 digest (see services.sessionStorageKey); rows minted
	// before stay raw-keyed until they expire. Try the digest first so the
	// steady-state cost is one lookup; only a miss there falls back to the
	// legacy raw key — a real database error never triggers a second query.
	session, err := queries.GetAuthSessionBySessionKey(ctx, sessionStorageKey(sessionKey))
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil, time.Time{}
		}
		// Never interpret a stored SHA-256 digest as a legacy bearer key.
		// Legacy keys are UUIDs; allowing the digest here makes hashing at
		// rest ineffective because a database dump can be used as cookies.
		if len(sessionKey) == sha256.Size*2 {
			if _, err := hex.DecodeString(sessionKey); err == nil {
				return nil, nil, time.Time{}
			}
		}
		session, err = queries.GetAuthSessionBySessionKey(ctx, sessionKey)
		if err != nil {
			return nil, nil, time.Time{}
		}
	}
	if !session.ExpiresAt.After(now) {
		return nil, nil, time.Time{}
	}

	user, err := queries.GetUserByID(ctx, session.UserID)
	if err != nil {
		return nil, nil, time.Time{}
	}
	if user.ProhibitLogin {
		return nil, nil, time.Time{}
	}

	effectiveExpiresAt := session.ExpiresAt
	var refreshedSession *db.AuthSession
	if session.ExpiresAt.Sub(now) <= sessionRefreshWindow {
		updated, err := queries.RefreshAuthSession(ctx, db.RefreshAuthSessionParams{
			SessionKey: session.SessionKey,
			ExpiresAt:  now.Add(sessionDuration),
		})
		if err == nil {
			refreshedSession = &updated
			effectiveExpiresAt = updated.ExpiresAt
		}
	}

	return &AuthInfo{
		User:        &user,
		IsTokenAuth: false,
		Scopes:      ScopeSet{},
	}, refreshedSession, effectiveExpiresAt
}

func loadTokenAuth(ctx context.Context, queries AuthLoaderQuerier, token string) *AuthInfo {
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	return loadTokenAuthByHash(ctx, queries, tokenHash)
}

// sessionStorageKey derives the auth_sessions.session_key storage form of a
// raw session key. It mirrors services.sessionStorageKey; keep both in lockstep
// (middleware cannot import services, which already imports middleware).
func sessionStorageKey(rawSessionKey string) string {
	sum := sha256.Sum256([]byte(rawSessionKey))
	return hex.EncodeToString(sum[:])
}

func loadTokenAuthByHash(ctx context.Context, queries AuthLoaderQuerier, tokenHash string) *AuthInfo {
	authRow, err := queries.GetAuthInfoByTokenHash(ctx, tokenHash)
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return loadOAuth2TokenAuth(ctx, queries, tokenHash)
	}

	_ = queries.UpdateAccessTokenLastUsed(ctx, authRow.TokenID)

	user := authRowToUser(authRow)
	if user.ProhibitLogin {
		return nil
	}

	return &AuthInfo{
		User:        &user,
		TokenID:     authRow.TokenID,
		TokenHash:   tokenHash,
		RawScopes:   authRow.TokenScopes,
		Scopes:      ParseTokenScopes(authRow.TokenScopes),
		IsTokenAuth: true,
		TokenSource: TokenSourcePersonalAccessToken,
	}
}

func loadOAuth2TokenAuth(ctx context.Context, queries AuthLoaderQuerier, tokenHash string) *AuthInfo {
	info, err := loadOAuth2AccessToken(ctx, queries, tokenHash)
	if err != nil {
		return nil
	}
	return info
}

func loadOAuth2AccessToken(ctx context.Context, queries interface {
	GetOAuth2AccessTokenByHash(ctx context.Context, tokenHash string) (db.Oauth2AccessToken, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}, tokenHash string) (*AuthInfo, error) {
	token, err := queries.GetOAuth2AccessTokenByHash(ctx, tokenHash)
	if err != nil {
		return nil, err
	}

	user, err := queries.GetUserByID(ctx, token.UserID)
	if err != nil {
		return nil, err
	}
	if !user.IsActive || user.ProhibitLogin {
		return nil, pgx.ErrNoRows
	}

	rawScopes := strings.Join(token.Scopes, ",")
	return &AuthInfo{
		User:        &user,
		TokenID:     token.ID,
		TokenHash:   tokenHash,
		OAuth2AppID: token.AppID,
		RawScopes:   rawScopes,
		Scopes:      ParseTokenScopes(rawScopes),
		IsTokenAuth: true,
		TokenSource: TokenSourceOAuth2AccessToken,
	}, nil
}

// ExtractToken extracts the API token from the Authorization header.
// Query-string auth is intentionally unsupported so tokens never leak into
// request URLs, browser history, or intermediary logs.
func ExtractToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth != "" {
		parts := strings.Fields(auth)
		if len(parts) == 2 {
			switch strings.ToLower(parts[0]) {
			case "token", "bearer":
				if isValidTokenFormat(parts[1]) {
					return parts[1]
				}
			}
		}

		if username, password, ok := r.BasicAuth(); ok && username != "" && isValidTokenFormat(password) {
			return password
		}
	}

	return ""
}

func isValidTokenFormat(token string) bool {
	switch {
	case strings.HasPrefix(token, "smithers_oat_"):
		return hasHexTail(strings.TrimPrefix(token, "smithers_oat_"), 64)
	case strings.HasPrefix(token, "smithers_"):
		return hasHexTail(strings.TrimPrefix(token, "smithers_"), 40)
	default:
		return false
	}
}

func hasHexTail(tail string, expectedLen int) bool {
	if len(tail) != expectedLen {
		return false
	}
	for _, ch := range tail {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func authRowToUser(authRow db.GetAuthInfoByTokenHashRow) db.User {
	return db.User{
		ID:            authRow.ID,
		Username:      authRow.Username,
		LowerUsername: authRow.LowerUsername,
		Email:         authRow.Email,
		LowerEmail:    authRow.LowerEmail,
		DisplayName:   authRow.DisplayName,
		Bio:           authRow.Bio,
		AvatarUrl:     authRow.AvatarUrl,
		WalletAddress: authRow.WalletAddress,
		UserType:      authRow.UserType,
		IsActive:      authRow.IsActive,
		IsAdmin:       authRow.IsAdmin,
		ProhibitLogin: authRow.ProhibitLogin,
		DeletedAt:     authRow.DeletedAt,
		LastLoginAt:   authRow.LastLoginAt,
		CreatedAt:     authRow.CreatedAt,
		UpdatedAt:     authRow.UpdatedAt,
	}
}
