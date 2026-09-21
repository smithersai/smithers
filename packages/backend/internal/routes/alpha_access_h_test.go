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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAlphaAccess_H_AdminNilServices(t *testing.T) {
	handler := AlphaAccessHandler{}

	cases := []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		req  *http.Request
	}{
		{"whitelist list", handler.GetAdminWhitelist, httptest.NewRequest(http.MethodGet, "/admin/alpha/whitelist", nil)},
		{"whitelist post", handler.PostAdminWhitelist, alphaAccessHAuthReq(http.MethodPost, "/admin/alpha/whitelist", `{"identity_type":"email","identity_value":"a@example.com"}`)},
		{"whitelist delete", handler.DeleteAdminWhitelist, withRouteParams(httptest.NewRequest(http.MethodDelete, "/admin/alpha/whitelist/email/a", nil), map[string]string{"identity_type": "email", "identity_value": "a"})},
		{"waitlist list", handler.GetAdminWaitlist, httptest.NewRequest(http.MethodGet, "/admin/alpha/waitlist", nil)},
		{"waitlist approve", handler.PostAdminWaitlistApprove, alphaAccessHAuthReq(http.MethodPost, "/admin/alpha/waitlist/approve", `{"email":"a@example.com"}`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.call(rec, tc.req)
			require.Equal(t, http.StatusNotFound, rec.Code)
		})
	}
}

func TestAlphaAccess_H_AdminServiceErrors(t *testing.T) {
	t.Run("post whitelist", func(t *testing.T) {
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			addWhitelistFn: func(context.Context, *db.User, services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
				return services.AlphaWhitelistEntry{}, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := alphaAccessHAuthReq(http.MethodPost, "/admin/alpha/whitelist", `{"identity_type":"email","identity_value":"a@example.com"}`)
		rec := httptest.NewRecorder()
		handler.PostAdminWhitelist(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("list waitlist", func(t *testing.T) {
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			listWaitlistFn: func(context.Context, services.ListWaitlistInput) (services.AlphaWaitlistListResult, error) {
				return services.AlphaWaitlistListResult{}, pkgerrors.Internal("waitlist unavailable")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/admin/alpha/waitlist", nil)
		rec := httptest.NewRecorder()
		handler.GetAdminWaitlist(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("approve waitlist", func(t *testing.T) {
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			approveWaitlistFn: func(context.Context, *db.User, string) (services.AlphaWaitlistEntry, error) {
				return services.AlphaWaitlistEntry{}, pkgerrors.BadRequest("invalid email")
			},
		}}
		req := alphaAccessHAuthReq(http.MethodPost, "/admin/alpha/waitlist/approve", `{"email":"bad"}`)
		rec := httptest.NewRecorder()
		handler.PostAdminWaitlistApprove(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func alphaAccessHAuthReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 7, Username: "admin", IsAdmin: true},
	}))
}
