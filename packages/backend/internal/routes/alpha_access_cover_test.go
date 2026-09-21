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
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAlphaAccess_Cov_WaitlistJoinBranches(t *testing.T) {
	t.Parallel()

	t.Run("nil service returns not found", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{}
		req := httptest.NewRequest(http.MethodPost, "/api/alpha/waitlist", strings.NewReader(`{"email":"a@example.com"}`))
		rec := httptest.NewRecorder()
		handler.PostWaitlistJoin(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "not configured")
	})

	t.Run("invalid json returns bad request", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			joinWaitlistFn: func(context.Context, services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error) {
				t.Fatal("service should not be called")
				return services.AlphaWaitlistEntry{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/alpha/waitlist", strings.NewReader(`{`))
		rec := httptest.NewRecorder()
		handler.PostWaitlistJoin(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service validation error is propagated", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			joinWaitlistFn: func(context.Context, services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error) {
				return services.AlphaWaitlistEntry{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Waitlist", Field: "email", Code: "invalid"})
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/alpha/waitlist", strings.NewReader(`{"email":"not-an-email"}`))
		rec := httptest.NewRecorder()
		handler.PostWaitlistJoin(rec, req)

		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		assert.Contains(t, rec.Body.String(), "email")
	})
}

func TestAlphaAccess_Cov_AdminWhitelistBranches(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()

	t.Run("get whitelist succeeds", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			listWhitelistFn: func(ctx context.Context) ([]services.AlphaWhitelistEntry, error) {
				return []services.AlphaWhitelistEntry{{
					ID:            10,
					IdentityType:  services.WhitelistIdentityEmail,
					IdentityValue: "a@example.com",
					CreatedAt:     now,
					UpdatedAt:     now,
				}}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/alpha/whitelist", nil)
		rec := httptest.NewRecorder()
		handler.GetAdminWhitelist(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var got []services.AlphaWhitelistEntry
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		require.Len(t, got, 1)
		assert.Equal(t, "a@example.com", got[0].IdentityValue)
	})

	t.Run("get whitelist propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			listWhitelistFn: func(context.Context) ([]services.AlphaWhitelistEntry, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/alpha/whitelist", nil)
		rec := httptest.NewRecorder()
		handler.GetAdminWhitelist(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("post whitelist rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			addWhitelistFn: func(context.Context, *db.User, services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
				t.Fatal("service should not be called")
				return services.AlphaWhitelistEntry{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/whitelist", strings.NewReader(`{`))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
		}))
		rec := httptest.NewRecorder()
		handler.PostAdminWhitelist(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete whitelist rejects missing identity value", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			removeWhitelistFn: func(context.Context, services.RemoveWhitelistEntryInput) error {
				t.Fatal("service should not be called")
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/alpha/whitelist/email/", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("identity_type", "email")
		routeCtx.URLParams.Add("identity_value", " ")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
		}))
		rec := httptest.NewRecorder()
		handler.DeleteAdminWhitelist(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete whitelist propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			removeWhitelistFn: func(ctx context.Context, input services.RemoveWhitelistEntryInput) error {
				assert.Equal(t, services.WhitelistIdentityEmail, input.IdentityType)
				assert.Equal(t, "missing@example.com", input.IdentityValue)
				return pkgerrors.NotFound("whitelist entry not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/admin/alpha/whitelist/email/missing%40example.com", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("identity_type", "email")
		routeCtx.URLParams.Add("identity_value", "missing%40example.com")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
		}))
		rec := httptest.NewRecorder()
		handler.DeleteAdminWhitelist(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestAlphaAccess_Cov_AdminWaitlistBranches(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()

	t.Run("get waitlist uses default limit fifty", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			listWaitlistFn: func(ctx context.Context, input services.ListWaitlistInput) (services.AlphaWaitlistListResult, error) {
				assert.Equal(t, 1, input.Page)
				assert.Equal(t, 50, input.PerPage)
				assert.Equal(t, services.WaitlistStatusPending, input.Status)
				return services.AlphaWaitlistListResult{
					Items: []services.AlphaWaitlistEntry{{
						ID:        7,
						Email:     "pending@example.com",
						Status:    services.WaitlistStatusPending,
						CreatedAt: now,
						UpdatedAt: now,
					}},
					TotalCount: 1,
					Page:       1,
					PerPage:    50,
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/alpha/waitlist?status=pending", nil)
		rec := httptest.NewRecorder()
		handler.GetAdminWaitlist(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var got services.AlphaWaitlistListResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		require.Len(t, got.Items, 1)
		assert.Equal(t, int64(1), got.TotalCount)
	})

	t.Run("get waitlist rejects invalid pagination", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			listWaitlistFn: func(context.Context, services.ListWaitlistInput) (services.AlphaWaitlistListResult, error) {
				t.Fatal("service should not be called")
				return services.AlphaWaitlistListResult{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/alpha/waitlist?page=0", nil)
		rec := httptest.NewRecorder()
		handler.GetAdminWaitlist(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("approve requires auth", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			approveWaitlistFn: func(context.Context, *db.User, string) (services.AlphaWaitlistEntry, error) {
				t.Fatal("service should not be called")
				return services.AlphaWaitlistEntry{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/waitlist/approve", strings.NewReader(`{"email":"a@example.com"}`))
		rec := httptest.NewRecorder()
		handler.PostAdminWaitlistApprove(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("approve rejects invalid json", func(t *testing.T) {
		t.Parallel()
		handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{
			approveWaitlistFn: func(context.Context, *db.User, string) (services.AlphaWaitlistEntry, error) {
				t.Fatal("service should not be called")
				return services.AlphaWaitlistEntry{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/waitlist/approve", strings.NewReader(`{`))
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
		}))
		rec := httptest.NewRecorder()
		handler.PostAdminWaitlistApprove(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
