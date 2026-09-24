package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func userCovRequest(method, target, body string, params map[string]string, user *db.User) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	for k, v := range params {
		routeCtx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	if user != nil {
		ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: user})
	}
	return req.WithContext(ctx)
}

func TestUser_Cov_PublicListsAndReadableRepos(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h := &UserHandler{ProfileService: mockUserProfileService{
		listUserActivityByUsernameFn: func(_ context.Context, username string, page, perPage int) (services.ActivityListResult, error) {
			assert.Equal(t, "octo", username)
			assert.Equal(t, 2, page)
			assert.Equal(t, 2, perPage)
			return services.ActivityListResult{
				Items:      []services.ActivitySummary{{ID: 1, EventType: "repo", Action: "create", Summary: "created repo", CreatedAt: now}},
				TotalCount: 3,
			}, nil
		},
		listUserStarredReposByUsernameFn: func(_ context.Context, username string, page, perPage int) (services.RepoListResult, error) {
			assert.Equal(t, "octo", username)
			assert.Equal(t, 1, page)
			assert.Equal(t, 30, perPage)
			return services.RepoListResult{
				Items:      []services.RepoSummary{{ID: 2, Owner: "octo", Name: "star", FullName: "octo/star", CreatedAt: now, UpdatedAt: now}},
				TotalCount: 1,
			}, nil
		},
		listReadableReposFn: func(_ context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error) {
			assert.Equal(t, int64(5), userID)
			assert.Equal(t, 1, page)
			assert.Equal(t, services.MaxReadableReposPerPage, perPage)
			return services.ReadableRepoListResult{
				Items:      []services.ReadableRepoRow{{ID: 3, Owner: "octo", Name: "readable"}},
				TotalCount: 1,
			}, nil
		},
	}}

	t.Run("activity", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/users/octo/activity?cursor=2&limit=2", "", map[string]string{"username": "octo"}, nil)
		rec := httptest.NewRecorder()
		h.GetUserActivityByUsername(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "3", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Body.String(), `"summary":"created repo"`)
	})

	t.Run("readable repos cap", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/readable-repos?limit=999", "", nil, &db.User{ID: 5, Username: "octo"})
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUserReadableRepos(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var rows []services.ReadableRepoRow
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		require.Len(t, rows, 1)
		assert.Equal(t, "readable", rows[0].Name)
	})

	t.Run("readable repos invalid limit", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/readable-repos?limit=nope", "", nil, &db.User{ID: 5, Username: "octo"})
		rec := httptest.NewRecorder()
		h.GetAuthenticatedUserReadableRepos(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestUser_Cov_EmailVerificationPreferencesAccountsAndAvatar(t *testing.T) {
	user := &db.User{ID: 5, Username: "octo", LowerUsername: "octo"}
	now := time.Now().UTC().Truncate(time.Second)
	emailSvc := mockUserEmailService{
		verifyEmailFn: func(_ context.Context, rawToken string) (services.VerifyEmailResult, error) {
			assert.Equal(t, "token-123", rawToken)
			return services.VerifyEmailResult{UserID: user.ID, Email: "octo@example.test"}, nil
		},
	}
	profileSvc := mockUserProfileService{
		getNotificationPreferencesFn: func(_ context.Context, userID int64) (services.NotificationPreferences, error) {
			assert.Equal(t, user.ID, userID)
			return services.NotificationPreferences{EmailNotificationsEnabled: true}, nil
		},
		updateNotificationPreferencesFn: func(_ context.Context, userID int64, req services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error) {
			assert.Equal(t, user.ID, userID)
			require.NotNil(t, req.EmailNotificationsEnabled)
			assert.False(t, *req.EmailNotificationsEnabled)
			return services.NotificationPreferences{EmailNotificationsEnabled: false}, nil
		},
		listConnectedAccountsFn: func(_ context.Context, userID int64) ([]services.ConnectedAccountResponse, error) {
			assert.Equal(t, user.ID, userID)
			return []services.ConnectedAccountResponse{{ID: 99, Provider: "github", ProviderID: "123", CreatedAt: now, UpdatedAt: now}}, nil
		},
		deleteConnectedAccountFn: func(_ context.Context, userID, accountID int64) error {
			assert.Equal(t, user.ID, userID)
			assert.Equal(t, int64(99), accountID)
			return nil
		},
		updateAuthenticatedUserFn: func(_ context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error) {
			assert.Equal(t, user.ID, userID)
			require.NotNil(t, req.AvatarURL)
			assert.Equal(t, "https://example.test/avatar.png", *req.AvatarURL)
			return services.UserProfile{ID: user.ID, Username: "octo", AvatarURL: *req.AvatarURL}, nil
		},
	}
	h := &UserHandler{EmailService: emailSvc, ProfileService: profileSvc}

	t.Run("get verify token", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/emails/verify-token?token=token-123", "", nil, nil)
		rec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"email":"octo@example.test"`)
	})

	t.Run("post verify token", func(t *testing.T) {
		req := userCovRequest(http.MethodPost, "/api/user/emails/verify-token", `{"token":"token-123"}`, nil, nil)
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("get preferences", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/notification-preferences", "", nil, user)
		rec := httptest.NewRecorder()
		h.GetNotificationPreferences(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"email_notifications_enabled":true`)
	})

	t.Run("put preferences", func(t *testing.T) {
		req := userCovRequest(http.MethodPut, "/api/user/notification-preferences", `{"email_notifications_enabled":false}`, nil, user)
		rec := httptest.NewRecorder()
		h.PutNotificationPreferences(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"email_notifications_enabled":false`)
	})

	t.Run("connected accounts", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/connected-accounts", "", nil, user)
		rec := httptest.NewRecorder()
		h.GetConnectedAccounts(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"provider":"github"`)
	})

	t.Run("delete connected account", func(t *testing.T) {
		req := userCovRequest(http.MethodDelete, "/api/user/connected-accounts/99", "", map[string]string{"id": "99"}, user)
		rec := httptest.NewRecorder()
		h.DeleteConnectedAccount(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

}

func TestUser_Cov_ErrorBranchesAndPaginationHelpers(t *testing.T) {
	user := &db.User{ID: 5, Username: "octo", LowerUsername: "octo"}
	h := &UserHandler{
		EmailService: mockUserEmailService{
			verifyEmailFn: func(context.Context, string) (services.VerifyEmailResult, error) {
				return services.VerifyEmailResult{}, apierrors.BadRequest("invalid or expired token")
			},
		},
		ProfileService: mockUserProfileService{
			getNotificationPreferencesFn: func(context.Context, int64) (services.NotificationPreferences, error) {
				return services.NotificationPreferences{}, apierrors.NotFound("preferences not found")
			},
			deleteConnectedAccountFn: func(context.Context, int64, int64) error {
				return apierrors.NotFound("connected account not found")
			},
			updateAuthenticatedUserFn: func(context.Context, int64, services.UpdateUserRequest) (services.UserProfile, error) {
				return services.UserProfile{}, apierrors.ValidationFailed(apierrors.FieldError{Resource: "User", Field: "avatar_url", Code: "invalid"})
			},
		},
	}

	t.Run("verify token required", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/emails/verify-token", "", nil, nil)
		rec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "token is required")
	})

	t.Run("post verify invalid json", func(t *testing.T) {
		req := userCovRequest(http.MethodPost, "/api/user/emails/verify-token", "{", nil, nil)
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("post verify empty token", func(t *testing.T) {
		req := userCovRequest(http.MethodPost, "/api/user/emails/verify-token", `{"token":""}`, nil, nil)
		rec := httptest.NewRecorder()
		h.PostUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "token is required")
	})

	t.Run("verify service error", func(t *testing.T) {
		req := userCovRequest(http.MethodGet, "/api/user/emails/verify-token?token=bad", "", nil, nil)
		rec := httptest.NewRecorder()
		h.GetUserEmailVerifyToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid or expired token")
	})

	t.Run("preferences unauthorized and service error", func(t *testing.T) {
		noAuthReq := userCovRequest(http.MethodGet, "/api/user/notification-preferences", "", nil, nil)
		noAuthRec := httptest.NewRecorder()
		h.GetNotificationPreferences(noAuthRec, noAuthReq)
		require.Equal(t, http.StatusUnauthorized, noAuthRec.Code)

		errReq := userCovRequest(http.MethodGet, "/api/user/notification-preferences", "", nil, user)
		errRec := httptest.NewRecorder()
		h.GetNotificationPreferences(errRec, errReq)
		require.Equal(t, http.StatusNotFound, errRec.Code)
	})

	t.Run("put preferences invalid json", func(t *testing.T) {
		req := userCovRequest(http.MethodPut, "/api/user/notification-preferences", "{", nil, user)
		rec := httptest.NewRecorder()
		h.PutNotificationPreferences(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("connected account invalid id and service error", func(t *testing.T) {
		invalidReq := userCovRequest(http.MethodDelete, "/api/user/connected-accounts/nope", "", map[string]string{"id": "nope"}, user)
		invalidRec := httptest.NewRecorder()
		h.DeleteConnectedAccount(invalidRec, invalidReq)
		require.Equal(t, http.StatusBadRequest, invalidRec.Code)

		errReq := userCovRequest(http.MethodDelete, "/api/user/connected-accounts/99", "", map[string]string{"id": "99"}, user)
		errRec := httptest.NewRecorder()
		h.DeleteConnectedAccount(errRec, errReq)
		require.Equal(t, http.StatusNotFound, errRec.Code)
	})

	t.Run("pagination helpers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/user/repos?tab=stars", nil)
		rec := httptest.NewRecorder()
		writeUserPaginationHeaders(rec, req, 25, "50")
		link := rec.Header().Get("Link")
		assert.Contains(t, link, `limit=25`)
		assert.Contains(t, link, `cursor=50`)
		assert.Contains(t, link, `rel="first"`)
		assert.Contains(t, userPaginationURL(req, 10, ""), "/api/user/repos?limit=10&tab=stars")
	})
}
