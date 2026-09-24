package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type userHAuditQuerier struct {
	calls int
	last  db.InsertAuditLogParams
}

func (q *userHAuditQuerier) InsertAuditLog(_ context.Context, arg db.InsertAuditLogParams) error {
	q.calls++
	q.last = arg
	return nil
}

func userHRequest(method, target, body string, params map[string]string, authed bool) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, params)
	if authed {
		req = withAuth(req, 10, "alice")
	}
	return req
}

func userHProfileErrorService() mockUserProfileService {
	err := apierrors.NotFound("missing")
	return mockUserProfileService{
		listAuthenticatedUserReposFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		listReadableReposFn: func(context.Context, int64, int, int) (services.ReadableRepoListResult, error) {
			return services.ReadableRepoListResult{}, err
		},
		listAuthenticatedUserOrgsFn: func(context.Context, int64, int, int) (services.OrgListResult, error) {
			return services.OrgListResult{}, err
		},
		listAuthenticatedUserStarredFn: func(context.Context, int64, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		listUserActivityByUsernameFn: func(context.Context, string, int, int) (services.ActivityListResult, error) {
			return services.ActivityListResult{}, err
		},
		listUserStarredReposByUsernameFn: func(context.Context, string, int, int) (services.RepoListResult, error) {
			return services.RepoListResult{}, err
		},
		getNotificationPreferencesFn: func(context.Context, int64) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, err
		},
		updateNotificationPreferencesFn: func(context.Context, int64, services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error) {
			return services.NotificationPreferences{}, err
		},
		listConnectedAccountsFn: func(context.Context, int64) ([]services.ConnectedAccountResponse, error) {
			return nil, err
		},
		deleteConnectedAccountFn: func(context.Context, int64, int64) error {
			return err
		},
		updateAuthenticatedUserFn: func(context.Context, int64, services.UpdateUserRequest) (services.UserProfile, error) {
			return services.UserProfile{}, err
		},
	}
}

func TestUser_H_TokenAndSessionBranches(t *testing.T) {
	t.Run("list token service error", func(t *testing.T) {
		h := &UserHandler{TokenService: mockUserTokenService{
			listTokensFn: func(context.Context, int64) ([]services.TokenSummary, error) {
				return nil, apierrors.NotFound("tokens missing")
			},
		}}
		req := userHRequest(http.MethodGet, "/api/user/tokens", "", nil, true)
		rec := httptest.NewRecorder()
		h.GetUserTokens(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("post token skips blank scope and audits", func(t *testing.T) {
		audit := &userHAuditQuerier{}
		h := &UserHandler{
			TokenService: mockUserTokenService{
				createTokenFn: func(_ context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
					require.Equal(t, int64(10), userID)
					require.Equal(t, []string{"   ", "write:user"}, req.Scopes)
					return services.CreateTokenResult{
						TokenSummary: services.TokenSummary{ID: 77, Name: req.Name},
						Token:        "smithers_token",
					}, nil
				},
			},
			AuditService: services.NewAuditService(audit),
		}
		req := httptest.NewRequest(http.MethodPost, "/api/user/tokens", strings.NewReader(`{"name":"deploy","scopes":["   ","write:user"]}`))
		req.Header.Set("Content-Type", "application/json")
		req = withTokenAuth(req, 10, "alice", middleware.ScopeWriteUser)
		rec := httptest.NewRecorder()
		h.PostUserToken(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		require.Equal(t, 1, audit.calls)
		require.Equal(t, "token.create", audit.last.EventType)
	})

	t.Run("delete token audits", func(t *testing.T) {
		audit := &userHAuditQuerier{}
		h := &UserHandler{
			TokenService: mockUserTokenService{
				deleteTokenFn: func(context.Context, int64, int64) error {
					return nil
				},
			},
			AuditService: services.NewAuditService(audit),
		}
		req := userHRequest(http.MethodDelete, "/api/user/tokens/77", "", map[string]string{"id": "77"}, true)
		rec := httptest.NewRecorder()
		h.DeleteUserToken(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, 1, audit.calls)
		require.Equal(t, "token.delete", audit.last.EventType)
	})

	t.Run("list sessions service error", func(t *testing.T) {
		h := &UserHandler{SessionService: mockUserSessionService{
			listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
				return nil, apierrors.NotFound("sessions missing")
			},
		}}
		req := userHRequest(http.MethodGet, "/api/user/sessions", "", nil, true)
		rec := httptest.NewRecorder()
		h.GetUserSessions(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("delete session empty id", func(t *testing.T) {
		h := &UserHandler{SessionService: mockUserSessionService{
			revokeSessionFn: func(context.Context, int64, string) error {
				t.Fatal("service should not be called")
				return nil
			},
		}}
		req := userHRequest(http.MethodDelete, "/api/user/sessions/%20", "", map[string]string{"id": " "}, true)
		rec := httptest.NewRecorder()
		h.DeleteUserSession(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestUser_H_ListAndPreferenceErrorBranches(t *testing.T) {
	defaultProfile := mockUserProfileService{}
	errorProfile := userHProfileErrorService()

	tests := []struct {
		name       string
		handler    func(*UserHandler, http.ResponseWriter, *http.Request)
		method     string
		target     string
		body       string
		params     map[string]string
		authed     bool
		service    mockUserProfileService
		wantStatus int
	}{
		{"activity invalid pagination", (*UserHandler).GetUserActivityByUsername, http.MethodGet, "/x?limit=bad", "", map[string]string{"username": "octo"}, false, defaultProfile, http.StatusBadRequest},
		{"activity service error", (*UserHandler).GetUserActivityByUsername, http.MethodGet, "/x", "", map[string]string{"username": "octo"}, false, errorProfile, http.StatusNotFound},
		{"authenticated repos no auth", (*UserHandler).GetAuthenticatedUserRepos, http.MethodGet, "/x", "", nil, false, defaultProfile, http.StatusUnauthorized},
		{"authenticated repos service error", (*UserHandler).GetAuthenticatedUserRepos, http.MethodGet, "/x", "", nil, true, errorProfile, http.StatusNotFound},
		{"readable repos service error", (*UserHandler).GetAuthenticatedUserReadableRepos, http.MethodGet, "/x", "", nil, true, errorProfile, http.StatusNotFound},
		{"authenticated orgs no auth", (*UserHandler).GetAuthenticatedUserOrgs, http.MethodGet, "/x", "", nil, false, defaultProfile, http.StatusUnauthorized},
		{"authenticated orgs invalid pagination", (*UserHandler).GetAuthenticatedUserOrgs, http.MethodGet, "/x?limit=bad", "", nil, true, defaultProfile, http.StatusBadRequest},
		{"authenticated orgs service error", (*UserHandler).GetAuthenticatedUserOrgs, http.MethodGet, "/x", "", nil, true, errorProfile, http.StatusNotFound},
		{"put preferences no auth", (*UserHandler).PutNotificationPreferences, http.MethodPut, "/x", `{}`, nil, false, defaultProfile, http.StatusUnauthorized},
		{"put preferences service error", (*UserHandler).PutNotificationPreferences, http.MethodPut, "/x", `{}`, nil, true, errorProfile, http.StatusNotFound},
		{"connected accounts no auth", (*UserHandler).GetConnectedAccounts, http.MethodGet, "/x", "", nil, false, defaultProfile, http.StatusUnauthorized},
		{"connected accounts service error", (*UserHandler).GetConnectedAccounts, http.MethodGet, "/x", "", nil, true, errorProfile, http.StatusNotFound},
		{"delete connected account no auth", (*UserHandler).DeleteConnectedAccount, http.MethodDelete, "/x", "", map[string]string{"id": "99"}, false, defaultProfile, http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &UserHandler{ProfileService: tt.service}
			req := userHRequest(tt.method, tt.target, tt.body, tt.params, tt.authed)
			rec := httptest.NewRecorder()

			tt.handler(h, rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestUser_H_EmailVerificationAndAccountBranches(t *testing.T) {
	t.Run("list emails service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			listEmailsFn: func(context.Context, int64) ([]services.EmailResponse, error) {
				return nil, apierrors.NotFound("emails missing")
			},
		}}
		req := userHRequest(http.MethodGet, "/api/user/emails", "", nil, true)
		rec := httptest.NewRecorder()
		h.GetUserEmails(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("verify token audits", func(t *testing.T) {
		audit := &userHAuditQuerier{}
		h := &UserHandler{
			EmailService: mockUserEmailService{
				verifyEmailFn: func(context.Context, string) (services.VerifyEmailResult, error) {
					return services.VerifyEmailResult{UserID: 10, Email: "alice@example.test"}, nil
				},
			},
			AuditService: services.NewAuditService(audit),
		}

		getReq := userHRequest(http.MethodGet, "/api/user/emails/verify-token?token=abc", "", nil, false)
		getRec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(getRec, getReq)
		require.Equal(t, http.StatusOK, getRec.Code)
		require.Equal(t, 1, audit.calls)
		require.Equal(t, "user.email.verified", audit.last.EventType)

		postReq := userHRequest(http.MethodPost, "/api/user/emails/verify-token", `{"token":"abc"}`, nil, false)
		postRec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(postRec, postReq)
		require.Equal(t, http.StatusNoContent, postRec.Code)
		require.Equal(t, 2, audit.calls)
		require.Equal(t, "user.email.verified", audit.last.EventType)
	})

	t.Run("post verify service error", func(t *testing.T) {
		h := &UserHandler{EmailService: mockUserEmailService{
			verifyEmailFn: func(context.Context, string) (services.VerifyEmailResult, error) {
				return services.VerifyEmailResult{}, apierrors.BadRequest("bad token")
			},
		}}
		req := userHRequest(http.MethodPost, "/api/user/emails/verify-token", `{"token":"bad"}`, nil, false)
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestUser_H_MustUserPaginationQuery(t *testing.T) {
	require.Equal(t, "limit=10", mustUserPaginationQuery("limit=10"))
	require.Panics(t, func() {
		mustUserPaginationQuery("")
	})
}
