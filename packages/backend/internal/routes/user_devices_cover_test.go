package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type userDevicesCovService struct {
	registerFn func(ctx context.Context, userID int64, req services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error)
	deleteFn   func(ctx context.Context, userID int64, apnsToken string) error
}

func (s *userDevicesCovService) RegisterDevice(ctx context.Context, userID int64, req services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error) {
	if s.registerFn != nil {
		return s.registerFn(ctx, userID, req)
	}
	return services.UserDeviceResponse{}, nil
}

func (s *userDevicesCovService) DeleteDevice(ctx context.Context, userID int64, apnsToken string) error {
	if s.deleteFn != nil {
		return s.deleteFn(ctx, userID, apnsToken)
	}
	return nil
}

func TestUserDevices_Cov_PostAndDeleteBranches(t *testing.T) {
	t.Parallel()

	t.Run("post requires configured service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/user/devices", strings.NewReader(`{}`)), 7, "alice")
		rec := httptest.NewRecorder()

		(&UserHandler{}).PostUserDevice(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "device service unavailable")
	})

	t.Run("post creates device and passes user id", func(t *testing.T) {
		now := time.Date(2026, 7, 7, 1, 2, 3, 0, time.UTC)
		h := &UserHandler{DeviceService: &userDevicesCovService{
			registerFn: func(ctx context.Context, userID int64, req services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error) {
				assert.Equal(t, int64(7), userID)
				assert.Equal(t, "token-1", req.APNSToken)
				assert.Equal(t, "ios", req.Platform)
				return services.UserDeviceResponse{ID: 9, UserID: userID, APNSToken: req.APNSToken, Platform: req.Platform, CreatedAt: now, LastSeenAt: now}, nil
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/user/devices", strings.NewReader(`{"apns_token":"token-1","platform":"ios"}`)), 7, "alice")
		rec := httptest.NewRecorder()

		h.PostUserDevice(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var body services.UserDeviceResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, int64(9), body.ID)
		assert.Equal(t, "token-1", body.APNSToken)
	})

	t.Run("post propagates service validation", func(t *testing.T) {
		h := &UserHandler{DeviceService: &userDevicesCovService{
			registerFn: func(context.Context, int64, services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error) {
				return services.UserDeviceResponse{}, pkgerrors.BadRequest("platform must be ios or android")
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/user/devices", strings.NewReader(`{"apns_token":"token-1","platform":"watch"}`)), 7, "alice")
		rec := httptest.NewRecorder()

		h.PostUserDevice(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "platform")
	})

	t.Run("delete removes token", func(t *testing.T) {
		h := &UserHandler{DeviceService: &userDevicesCovService{
			deleteFn: func(ctx context.Context, userID int64, apnsToken string) error {
				assert.Equal(t, int64(8), userID)
				assert.Equal(t, "token-2", apnsToken)
				return nil
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodDelete, "/api/user/devices", strings.NewReader(`{"apns_token":"token-2"}`)), 8, "bob")
		rec := httptest.NewRecorder()

		h.DeleteUserDevice(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("delete propagates not found", func(t *testing.T) {
		h := &UserHandler{DeviceService: &userDevicesCovService{
			deleteFn: func(context.Context, int64, string) error {
				return pkgerrors.NotFound("device not found")
			},
		}}
		req := withAuth(httptest.NewRequest(http.MethodDelete, "/api/user/devices", strings.NewReader(`{"apns_token":"missing"}`)), 8, "bob")
		rec := httptest.NewRecorder()

		h.DeleteUserDevice(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "device not found")
	})
}
